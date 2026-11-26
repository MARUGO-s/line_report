import { GROQ_VISION_BASE64_MAX_BYTES } from './receipt_types.ts'

const MAX_INPUT_BYTES = 8 * 1024 * 1024
const MAX_DECODED_PIXELS = 5_000_000
const MAX_OUTPUT_PIXELS = 3_000_000
const MAX_OUTPUT_EDGE = 2500
const MAX_ANGLE = 8
const ANGLE_STEP = 0.25

type RgbaImage = {
  data: Uint8Array
  width: number
  height: number
}

export type PreparedBarPelotaReceiptImage = {
  bytes: Uint8Array
  contentType: string | null
  correctionDegrees: number
  countsDetail?: { bytes: Uint8Array; contentType: string }
}

function pngCanBeDecoded(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.length < 33 || !signature.every((byte, index) => bytes[index] === byte)) return false

  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452) return false

  const width = header.getUint32(16)
  const height = header.getUint32(20)
  // pngjs caps inflated data for noninterlaced files. Keep other formats on the original path.
  return width > 0 && height > 0 && width * height <= MAX_DECODED_PIXELS && bytes[28] === 0
}

function greySample(data: Uint8Array, offset: number): number {
  const luminance = (data[offset] * 77 + data[offset + 1] * 150 + data[offset + 2] * 29) / 256
  return 255 + (luminance - 255) * (data[offset + 3] / 255)
}

function makePreview(image: RgbaImage): { data: Uint8Array; width: number; height: number } {
  const scale = Math.min(1, 384 / image.width, 960 / image.height)
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const data = new Uint8Array(width * height)
  const stepX = image.width / width
  const stepY = image.height / height
  for (let y = 0; y < height; y++) {
    const top = Math.floor((y + 0.25) * stepY) * image.width * 4
    const bottom = Math.floor((y + 0.75) * stepY) * image.width * 4
    for (let x = 0; x < width; x++) {
      const left = Math.floor((x + 0.25) * stepX) * 4
      const right = Math.floor((x + 0.75) * stepX) * 4
      data[y * width + x] = (
        greySample(image.data, top + left) +
        greySample(image.data, top + right) +
        greySample(image.data, bottom + left) +
        greySample(image.data, bottom + right)
      ) / 4
    }
  }
  return { data, width, height }
}

/** Estimate the printed row slope from local ink contrast in the transaction section. */
export function estimateBarPelotaReceiptSkew(image: RgbaImage): number {
  const { data, width, height } = makePreview(image)
  if (width < 48 || height < 80) return 0
  const xs: number[] = []
  const ys: number[] = []
  const weights: number[] = []
  const radius = 4
  const centerX = width / 2
  let leftInk = 0
  let rightInk = 0

  // Transaction labels and values sit in this part of the long receipt. Top rules
  // carry little evidence of the local slope near the totals on a curved receipt.
  for (let y = Math.floor(0.59 * height); y < Math.floor(0.95 * height); y++) {
    for (let x = Math.floor(0.11 * width); x < Math.floor(0.94 * width); x++) {
      const index = y * width + x
      const surrounding = Math.max(data[index - radius * width], data[index + radius * width])
      const current = data[index]
      if (surrounding < 45 || current < 12) continue
      const contrast = Math.min(70, (surrounding - current) * 100 / (surrounding + 25) - 5)
      if (contrast <= 0) continue
      xs.push(x - centerX)
      ys.push(y)
      weights.push(contrast)
      if (x < width * 0.46) leftInk++
      if (x > width * 0.68) rightInk++
    }
  }
  if (leftInk < 120 || rightInk < 120) return 0

  const steps = MAX_ANGLE / ANGLE_STEP
  const scores = new Float64Array(2 * steps + 1)
  const pad = Math.ceil(Math.tan(MAX_ANGLE * Math.PI / 180) * centerX) + 2
  const projection = new Float64Array(height + 2 * pad)
  for (let angleIndex = 0; angleIndex < scores.length; angleIndex++) {
    const slope = Math.tan((angleIndex - steps) * ANGLE_STEP * Math.PI / 180)
    projection.fill(0)
    for (let i = 0; i < xs.length; i++) {
      const projectedY = ys[i] - slope * xs[i] + pad
      const row = Math.floor(projectedY)
      const mix = projectedY - row
      projection[row] += weights[i] * (1 - mix)
      projection[row + 1] += weights[i] * mix
    }
    for (let y = 1; y < projection.length; y++) {
      const concentration = projection[y] + projection[y - 1]
      scores[angleIndex] += concentration * concentration
    }
  }
  let best = steps
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] > scores[best]) best = i
  }
  const angle = (best - steps) * ANGLE_STEP
  // An upright image, a negligible gain, or a similarly good unrelated slope
  // gives too little evidence to justify changing the original.
  if (Math.abs(angle) < 0.5 || best === 0 || best === scores.length - 1 || scores[best] < scores[steps] * 1.03) return 0
  for (let i = 0; i < scores.length; i++) {
    if (Math.abs(i - best) * ANGLE_STEP > 1.4 && scores[best] < scores[i] * 1.012) return 0
  }

  const curvature = scores[best - 1] - 2 * scores[best] + scores[best + 1]
  const adjustment = curvature < 0
    ? (scores[best - 1] - scores[best + 1]) / (2 * curvature) * ANGLE_STEP
    : 0
  return angle + adjustment
}

function straightenImage(image: RgbaImage, angle: number): RgbaImage {
  const slope = Math.tan(angle * Math.PI / 180)
  const centerX = (image.width - 1) / 2
  const padding = Math.ceil(Math.abs(slope) * centerX)
  const fullHeight = image.height + padding * 2
  const scale = Math.min(
    1,
    MAX_OUTPUT_EDGE / Math.max(image.width, fullHeight),
    Math.sqrt(MAX_OUTPUT_PIXELS / (image.width * fullHeight)),
  )
  const width = Math.max(1, Math.floor(image.width * scale))
  const height = Math.max(1, Math.floor(fullHeight * scale))
  const data = new Uint8Array(width * height * 4).fill(255)
  const sourceColumns = new Int32Array(width)
  const verticalOffsets = new Float64Array(width)
  for (let x = 0; x < width; x++) {
    sourceColumns[x] = Math.floor((x + 0.5) * image.width / width)
    verticalOffsets[x] = slope * (sourceColumns[x] - centerX)
  }
  for (let y = 0; y < height; y++) {
    const destY = (y + 0.5) * fullHeight / height - 0.5 - padding
    for (let x = 0; x < width; x++) {
      const sourceY = destY + verticalOffsets[x]
      if (sourceY < 0 || sourceY >= image.height) continue
      const y0 = Math.floor(sourceY)
      const y1 = Math.min(y0 + 1, image.height - 1)
      const top = (y0 * image.width + sourceColumns[x]) * 4
      const bottom = (y1 * image.width + sourceColumns[x]) * 4
      const blend = sourceY - y0
      const topWeight = (1 - blend) * (image.data[top + 3] / 255)
      const bottomWeight = blend * (image.data[bottom + 3] / 255)
      const dest = (y * width + x) * 4
      for (let c = 0; c < 3; c++) {
        data[dest + c] = 255 + (image.data[top + c] - 255) * topWeight + (image.data[bottom + c] - 255) * bottomWeight
      }
    }
  }
  return { data, width, height }
}

/** Retain both printed columns at their original pixel spacing for the count OCR. */
export function cropBarPelotaCountsDetail(image: RgbaImage): RgbaImage {
  const top = Math.floor(image.height * 0.57)
  const end = Math.ceil(image.height * 0.985)
  const stride = image.width * 4
  return {
    width: image.width,
    height: end - top,
    data: image.data.subarray(top * stride, end * stride),
  }
}

export async function prepareBarPelotaReceiptImage(
  bytes: Uint8Array,
  contentType: string | null,
): Promise<PreparedBarPelotaReceiptImage> {
  const original = { bytes, contentType, correctionDegrees: 0 }
  const mime = contentType?.trim().toLowerCase()
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_INPUT_BYTES) return original
  if (mime !== 'image/jpeg' && mime !== 'image/jpg' && mime !== 'image/png') return original

  try {
    let image: RgbaImage
    const jpeg = await import('https://esm.sh/jpeg-js@0.4.4')
    if (mime === 'image/png') {
      if (!pngCanBeDecoded(bytes)) return original
      const [{ PNG }, { Buffer }] = await Promise.all([import('npm:pngjs@7.0.0'), import('node:buffer')])
      image = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    } else {
      image = jpeg.decode(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        maxResolutionInMP: MAX_DECODED_PIXELS / 1_000_000,
        maxMemoryUsageInMB: 64,
      })
    }
    if (image.width * image.height > MAX_DECODED_PIXELS) return original
    const angle = estimateBarPelotaReceiptSkew(image)
    const needsFullEncoding = angle !== 0 || bytes.byteLength > GROQ_VISION_BASE64_MAX_BYTES
    const prepared = needsFullEncoding ? straightenImage(image, angle) : image
    let fullImage: PreparedBarPelotaReceiptImage = original
    if (needsFullEncoding) {
      const encoded = jpeg.encode(prepared, 94).data
      if (encoded.byteLength <= GROQ_VISION_BASE64_MAX_BYTES) {
        fullImage = {
          bytes: new Uint8Array(encoded),
          contentType: 'image/jpeg',
          correctionDegrees: angle === 0 ? 0 : -Math.round(angle * 100) / 100,
        }
      }
    }

    try {
      const detail = jpeg.encode(cropBarPelotaCountsDetail(prepared), 94).data
      if (detail.byteLength <= GROQ_VISION_BASE64_MAX_BYTES) {
        return { ...fullImage, countsDetail: { bytes: new Uint8Array(detail), contentType: 'image/jpeg' } }
      }
    } catch {
      // The full image is still available when the optional detail cannot be encoded.
    }
    return fullImage
  } catch {
    // The regular OCR and its verification gate still handle the original image.
    return original
  }
}
