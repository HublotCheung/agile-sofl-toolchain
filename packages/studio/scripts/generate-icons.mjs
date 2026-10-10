#!/usr/bin/env node
/**
 * Generate Electron app icons and title-bar logo from assets/logo.png.
 *
 * Outputs:
 *   build/icon.png      — 512×512 (electron-builder default)
 *   build/icon.ico      — Windows multi-size icon
 *   build/icon.icns     — macOS icon
 *   build/icons/*.png   — Linux / platform-specific sizes
 *   public/logo.png     — 32×32 title-bar logo for the renderer
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import png2icons from 'png2icons'

const studioRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = join(studioRoot, 'assets', 'logo.png')
const buildDir = join(studioRoot, 'build')
const iconsDir = join(buildDir, 'icons')
const publicLogoPath = join(studioRoot, 'public', 'logo.png')

const APP_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const TITLEBAR_SIZE = 32

if (!existsSync(sourcePath)) {
  console.error(`Missing source logo: ${sourcePath}`)
  process.exit(1)
}

/** Drop excess transparent margins so the mark fills icon squares at small sizes. */
async function loadTrimmedLogo() {
  return sharp(sourcePath).trim().png().toBuffer()
}

/** Square-fit; only pads when the trimmed artwork is not square. */
function fitSquare(trimmedLogo, size) {
  return sharp(trimmedLogo)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
}

async function main() {
  const trimmedLogo = await loadTrimmedLogo()
  const trimmedMeta = await sharp(trimmedLogo).metadata()
  console.log(
    `Trimmed logo to ${trimmedMeta.width}×${trimmedMeta.height} (from ${sourcePath.replace(studioRoot, 'packages/studio')})`
  )

  mkdirSync(iconsDir, { recursive: true })
  mkdirSync(join(studioRoot, 'public'), { recursive: true })

  for (const size of APP_ICON_SIZES) {
    const out = join(iconsDir, `${size}x${size}.png`)
    await fitSquare(trimmedLogo, size).toFile(out)
    console.log(`Wrote ${out.replace(studioRoot, 'packages/studio')}`)
  }

  const icon512 = join(buildDir, 'icon.png')
  await fitSquare(trimmedLogo, 512).toFile(icon512)
  console.log(`Wrote ${icon512.replace(studioRoot, 'packages/studio')}`)

  const icoBuffers = await Promise.all(
    ICO_SIZES.map((size) => fitSquare(trimmedLogo, size).toBuffer())
  )
  const ico = await pngToIco(icoBuffers)
  writeFileSync(join(buildDir, 'icon.ico'), ico)
  console.log('Wrote build/icon.ico')

  const icnsSource = await fitSquare(trimmedLogo, 1024).toBuffer()
  const icns = png2icons.createICNS(icnsSource, png2icons.BILINEAR, 0)
  if (!icns) {
    console.error('Failed to generate icon.icns')
    process.exit(1)
  }
  writeFileSync(join(buildDir, 'icon.icns'), icns)
  console.log('Wrote build/icon.icns')

  await fitSquare(trimmedLogo, TITLEBAR_SIZE).toFile(publicLogoPath)
  console.log(`Wrote ${publicLogoPath.replace(studioRoot, 'packages/studio')}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
