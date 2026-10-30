/**
 * Browser-only parts of /visualize: turning a validated spec into a point cloud, including the
 * portrait relief, which needs the image's pixels and so a canvas.
 */
import portraitAsset from "@/app/static/freya.png";
import { samplePartsCloud, sampleReliefCloud, type PointCloud, type VisualSpec } from "@/lib/visualize";

let portraitPixels: Promise<{ data: Uint8ClampedArray; width: number; height: number }> | null = null;

/** The portrait's head and shoulders, read once at a small size. */
function loadPortrait() {
  portraitPixels ??= new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      // Centre crop: the face and hair, not the empty sides (or the corner watermark).
      const crop = { x: image.naturalWidth * 0.28, y: 0, width: image.naturalWidth * 0.44, height: image.naturalHeight * 0.92 };
      const width = 260;
      const height = Math.round((crop.height / crop.width) * width);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) { reject(new Error("Canvas unavailable")); return; }
      context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
      resolve({ data: context.getImageData(0, 0, width, height).data, width, height });
    };
    image.onerror = () => { portraitPixels = null; reject(new Error("Portrait unavailable")); };
    image.src = portraitAsset.src;
  });
  return portraitPixels;
}

export async function cloudForSpec(spec: VisualSpec, count: number): Promise<PointCloud> {
  if (spec.technique === "portrait") {
    const { data, width, height } = await loadPortrait();
    return sampleReliefCloud(data, width, height, count, 1.3);
  }
  // Smaller than the canvas's half-height, so tall forms aren't cut off as they turn.
  return samplePartsCloud(spec, count, 1.1);
}
