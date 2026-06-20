import sharp from "sharp";
import path from "path";
import fs from "fs/promises";

export async function placeOnTemplate(inputPath: string, outputPath: string) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const product = await sharp(inputPath).resize({ width: 1200, height: 1800, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  await sharp({ create: { width: 1500, height: 2250, channels: 4, background: "#f5f5f5" } })
    .composite([{ input: product, gravity: "center" }])
    .jpeg({ quality: 92 })
    .toFile(outputPath);
  return outputPath;
}
