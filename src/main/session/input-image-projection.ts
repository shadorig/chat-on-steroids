import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import sharp from 'sharp';
import {
  canAttemptImageProjection,
  MAX_PROJECTED_IMAGE_BYTES,
  MAX_PROJECTED_IMAGE_COUNT,
  MAX_PROJECTED_IMAGE_DATA_URL_CHARS,
  MAX_PROJECTED_IMAGE_SOURCE_BYTES,
  type InputAttachment,
  type InputImage
} from '../../shared/input.js';
import { readInputAttachmentBytes } from './input-attachments.js';
import { inputBlobDirectory, inputBlobFile, serializeInputBlobStore } from './input-blob-store.js';

export const projectedImageRefSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(110),
  size: z.number().int().positive().max(MAX_PROJECTED_IMAGE_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ProjectedImageRef = z.infer<typeof projectedImageRefSchema>;
const projectedImageFileSchema = z.object({ kind: z.literal('tool-image-projection'),
  id: projectedImageRefSchema.shape.id, name: projectedImageRefSchema.shape.name,
  size: projectedImageRefSchema.shape.size, sha256: projectedImageRefSchema.shape.sha256 }).strict();

const LOSSY_PROJECTION_PROFILES = [
  { size: 1600, quality: 82 },
  { size: 1280, quality: 74 },
  { size: 1024, quality: 70 }
] as const;
const LOSSLESS_FIRST_PROJECTION_PROFILES = [
  { size: 1600, lossless: true },
  ...LOSSY_PROJECTION_PROFILES.slice(1)
] as const;
/** One normalized representation for tool injection and its recorded assets. */
export async function normalizeInputImage(data: Buffer, name: string): Promise<InputImage> {
  if (data.length > MAX_PROJECTED_IMAGE_SOURCE_BYTES) throw new Error('Images for the current turn must be 12 MB or smaller');
  const decoder = sharp(data, { limitInputPixels: 30_000_000, animated: false });
  const metadata = await decoder.metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) throw new Error('Add PNG, JPEG or WebP images to the current turn; send GIFs as native attachments');
  const base = name.replace(/\.[^.]+$/, '') || 'image';
  if (metadata.format === 'webp' && data.length <= MAX_PROJECTED_IMAGE_BYTES && metadata.width && metadata.height &&
      metadata.width <= 1600 && metadata.height <= 1600 && (!metadata.orientation || metadata.orientation === 1)) {
    // Preserve an already-valid projection byte-for-byte. Full decode is required because metadata
    // alone can succeed on a truncated WebP that would fail at the eventual MCP image boundary.
    await decoder.stats();
    return { name: `${base.slice(0, 105)}.webp`, dataUrl: `data:image/webp;base64,${data.toString('base64')}` };
  }
  // JPEG photographs almost never beat a 384 KB ceiling as lossless WebP; spending a full encode
  // on that attempt only adds latency. PNG/WebP can still profit from one lossless preservation
  // attempt. Either path is deliberately capped at three encodes.
  const profiles = metadata.format === 'jpeg' ? LOSSY_PROJECTION_PROFILES : LOSSLESS_FIRST_PROJECTION_PROFILES;
  for (const variant of profiles) {
    const pipeline = sharp(data, { limitInputPixels: 30_000_000, animated: false }).rotate()
      .resize({ width: variant.size, height: variant.size, fit: 'inside', withoutEnlargement: true });
    const bytes = 'lossless' in variant
      ? await pipeline.webp({ lossless: true }).toBuffer()
      : await pipeline.webp({ quality: variant.quality }).toBuffer();
    if (bytes.length > MAX_PROJECTED_IMAGE_BYTES) continue;
    return { name: `${base.slice(0, 105)}.webp`, dataUrl: `data:image/webp;base64,${bytes.toString('base64')}` };
  }
  throw new Error('Image could not fit the current-turn image envelope; use After this turn to upload the original');
}
export async function validateInputImages(images: InputImage[]): Promise<void> {
  if (images.length > MAX_PROJECTED_IMAGE_COUNT) throw new Error('Invalid image attachment');
  for (const image of images) {
    if (!/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(image.dataUrl) || image.dataUrl.length > MAX_PROJECTED_IMAGE_DATA_URL_CHARS) throw new Error('Invalid image attachment');
    const data = Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), 'base64');
    const decoded = sharp(data, { limitInputPixels: 2_560_000, animated: false });
    const metadata = await decoded.metadata();
    if (metadata.format !== 'webp' || !metadata.width || !metadata.height || metadata.width > 1600 || metadata.height > 1600) throw new Error('Invalid image attachment');
    await decoded.stats();
  }
}

/** Resolve authored originals one at a time and freeze bounded immutable transport projections. */
export async function createToolImageProjections(attachments: InputAttachment[]): Promise<ProjectedImageRef[]> {
  if (!canAttemptImageProjection(attachments)) throw new Error('Add up to four PNG, JPEG or WebP images to the current turn');
  const projections: ProjectedImageRef[] = [];
  try {
    for (const attachment of attachments) {
      const bytes = await readInputAttachmentBytes(attachment);
      projections.push(await storeToolImageProjection(await normalizeInputImage(bytes, attachment.name)));
    }
    return projections;
  } catch (error) {
    await deleteToolImageProjections(projections).catch(() => undefined);
    throw error;
  }
}

function storeToolImageProjection(image: InputImage): Promise<ProjectedImageRef> {
  return serializeInputBlobStore(async () => {
    const bytes = Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), 'base64');
    if (!bytes.length || bytes.length > MAX_PROJECTED_IMAGE_BYTES) throw new Error('Invalid image projection');
    const ref = projectedImageRefSchema.parse({ id: randomUUID(), name: image.name, size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') });
    await fs.mkdir(inputBlobDirectory(), { recursive: true });
    const destination = inputBlobFile(ref.id);
    try {
      await fs.writeFile(destination, bytes, { flag: 'wx' });
      await fs.writeFile(destination + '.json', JSON.stringify({ kind: 'tool-image-projection', ...ref }), { flag: 'wx' });
      return ref;
    } catch (error) {
      await fs.unlink(destination).catch(() => undefined);
      await fs.unlink(destination + '.json').catch(() => undefined);
      throw error;
    }
  });
}

/** Roll back derived transport material that never acquired or no longer needs a durable outbox owner. */
export function deleteToolImageProjections(refs: readonly ProjectedImageRef[]): Promise<void> {
  if (!refs.length) return Promise.resolve();
  return serializeInputBlobStore(async () => {
    for (const raw of refs) {
      const ref = projectedImageRefSchema.parse(raw);
      const file = inputBlobFile(ref.id);
      await fs.unlink(file).catch(() => undefined);
      await fs.unlink(file + '.json').catch(() => undefined);
    }
  });
}

export async function readToolImageProjections(refs: readonly ProjectedImageRef[]): Promise<InputImage[]> {
  const images: InputImage[] = [];
  for (const raw of refs) {
    const ref = projectedImageRefSchema.parse(raw);
    const file = inputBlobFile(ref.id);
    // Published projection ids are immutable. Their lifetime is fenced by the durable outbox, so
    // reads do not need to queue behind unrelated staging/pruning mutations in the shared store.
    const [metadataText, bytes] = await Promise.all([fs.readFile(file + '.json', 'utf8'), fs.readFile(file)]);
    const stored = projectedImageFileSchema.parse(JSON.parse(metadataText));
    if (stored.id !== ref.id || stored.name !== ref.name || stored.size !== ref.size || stored.sha256 !== ref.sha256 || bytes.length !== ref.size ||
        createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new Error('Image projection is missing or changed; send again');
    images.push({ name: ref.name, dataUrl: `data:image/webp;base64,${bytes.toString('base64')}` });
  }
  return images;
}
