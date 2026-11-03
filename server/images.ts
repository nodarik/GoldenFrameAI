import sharp from "sharp";

export type Img = { buf: Buffer; w: number; h: number };
// Pixel box with exclusive right/bottom, same convention as the SAM parser.
export type Box = { left: number; top: number; right: number; bottom: number };

const MAX_SIDE = 1600;

// Apply EXIF rotation, cap the long side, re-encode as JPEG. Strips metadata (incl. GPS)
// and rejects anything that isn't a decodable image.
export async function normalise(input: Buffer): Promise<Img> {
  const buf = await sharp(input, { failOn: "error" })
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  const { width, height } = await sharp(buf).metadata();
  return { buf, w: width!, h: height! };
}

export async function load(buf: Buffer): Promise<Img> {
  const { width, height } = await sharp(buf).metadata();
  return { buf, w: width!, h: height! };
}

export const dataUrl = (img: Img) => `data:image/jpeg;base64,${img.buf.toString("base64")}`;

export async function crop(img: Img, box: Box, marginFrac = 0.1): Promise<Img> {
  const mx = Math.round((box.right - box.left) * marginFrac);
  const my = Math.round((box.bottom - box.top) * marginFrac);
  const left = Math.max(0, box.left - mx), top = Math.max(0, box.top - my);
  const right = Math.min(img.w, box.right + mx), bottom = Math.min(img.h, box.bottom + my);
  const buf = await sharp(img.buf).extract({ left, top, width: right - left, height: bottom - top }).jpeg().toBuffer();
  return { buf, w: right - left, h: bottom - top };
}

export const area = (b: Box) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);

export function iou(a: Box, b: Box): number {
  const inter = area({
    left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom),
  });
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

export const toUnit = (b: Box, img: Img): Box => ({
  left: b.left / img.w, top: b.top / img.h, right: b.right / img.w, bottom: b.bottom / img.h,
});

export const fromUnit = (b: Box, img: Img): Box => ({
  left: b.left * img.w, top: b.top * img.h, right: b.right * img.w, bottom: b.bottom * img.h,
});
