const sharp = require(`./safe-sharp`)
const fs = require(`fs-extra`)
const debug = require(`debug`)(`gatsby:gatsby-plugin-sharp`)
const duotone = require(`./duotone`)
const imagemin = require(`imagemin`)
const imageminMozjpeg = require(`imagemin-mozjpeg`)
const imageminPngquant = require(`imagemin-pngquant`)
const imageminWebp = require(`imagemin-webp`)
const _ = require(`lodash`)
const crypto = require(`crypto`)

// Try to enable the use of SIMD instructions. Seems to provide a smallish
// speedup on resizing heavy loads (~10%). Sharp disables this feature by
// default as there's been problems with segfaulting in the past but we'll be
// adventurous and see what happens with it on.
sharp.simd(true)

try {
  // Handle Sharp's concurrency based on the Gatsby CPU count
  // See: http://sharp.pixelplumbing.com/en/stable/api-utility/#concurrency
  // See: https://www.gatsbyjs.org/docs/multi-core-builds/
  const cpuCoreCount = require(`gatsby/dist/utils/cpu-core-count`)
  sharp.concurrency(cpuCoreCount())
} catch {
  // if above throws error this probably means that used Gatsby version
  // doesn't support cpu-core-count utility.
}

/**
 * List of arguments used by `processFile` function.
 * This is used to generate args hash using only
 * arguments that affect output of that function.
 */
const argsWhitelist = [
  `height`,
  `width`,
  `cropFocus`,
  `toFormat`,
  `pngCompressionLevel`,
  `quality`,
  `jpegProgressive`,
  `grayscale`,
  `rotate`,
  `duotone`,
  `fit`,
  `background`,
]

/**
 * @typedef {Object} TransformArgs
 * @property {number} height
 * @property {number} width
 * @property {number} cropFocus
 * @property {string} toFormat
 * @property {number} pngCompressionLevel
 * @property {number} quality
 * @property {boolean} jpegProgressive
 * @property {boolean} grayscale
 * @property {number} rotate
 * @property {object} duotone
 */

/**+
 * @typedef {Object} Transform
 * @property {string} outputPath
 * @property {TransformArgs} args
 */

/**
 * @param {String} file
 * @param {Transform[]} transforms
 */
exports.processFile = (file, transforms, options = {}) => {
  let pipeline
  try {
    pipeline = sharp(file)

    // Keep Metadata
    if (!options.stripMetadata) {
      pipeline = pipeline.withMetadata()
    }
  } catch (err) {
    throw new Error(`Failed to process image ${file}`)
  }

  return transforms.map(async transform => {
    const { outputPath, args } = transform
    debug(`Start processing ${outputPath}`)

    let clonedPipeline = transforms.length > 1 ? pipeline.clone() : pipeline

    if (!args.rotate || args.rotate === 0) {
      clonedPipeline = clonedPipeline.rotate()
    }

    // Sharp only allows ints as height/width. Since both aren't always
    // set, check first before trying to round them.
    let roundedHeight = args.height
    if (roundedHeight) {
      roundedHeight = Math.round(roundedHeight)
    }

    let roundedWidth = args.width
    if (roundedWidth) {
      roundedWidth = Math.round(roundedWidth)
    }

    clonedPipeline
      .resize(roundedWidth, roundedHeight, {
        position: args.cropFocus,
        fit: args.fit,
        background: args.background,
      })
      .png({
        compressionLevel: args.pngCompressionLevel,
        adaptiveFiltering: false,
        force: args.toFormat === `png`,
      })
      .webp({
        quality: args.quality,
        force: args.toFormat === `webp`,
      })
      .tiff({
        quality: args.quality,
        force: args.toFormat === `tiff`,
      })

    // jpeg
    if (!options.useMozJpeg) {
      clonedPipeline = clonedPipeline.jpeg({
        quality: args.quality,
        progressive: args.jpegProgressive,
        force: args.toFormat === `jpg`,
      })
    }

    // grayscale
    if (args.grayscale) {
      clonedPipeline = clonedPipeline.grayscale()
    }

    // rotate
    if (args.rotate && args.rotate !== 0) {
      clonedPipeline = clonedPipeline.rotate(args.rotate)
    }

    // duotone
    if (args.duotone) {
      clonedPipeline = await duotone(
        args.duotone,
        args.toFormat,
        clonedPipeline
      )
    }

    // lets decide how we want to save this transform
    if (args.toFormat === `png`) {
      await compressPng(clonedPipeline, outputPath, {
        ...args,
        stripMetadata: options.stripMetadata,
      })
      return transform
    }

    if (options.useMozJpeg && args.toFormat === `jpg`) {
      await compressJpg(clonedPipeline, outputPath, args)
      return transform
    }

    if (args.toFormat === `webp`) {
      await compressWebP(clonedPipeline, outputPath, args)
      return transform
    }

    await clonedPipeline.toFile(outputPath)
    return transform
  })
}

const compressPng = (pipeline, outputPath, options) =>
  pipeline.toBuffer().then(sharpBuffer =>
    imagemin
      .buffer(sharpBuffer, {
        plugins: [
          imageminPngquant({
            quality: `${options.quality}-${Math.min(
              options.quality + 25,
              100
            )}`, // e.g. 40-65
            speed: options.pngCompressionSpeed
              ? options.pngCompressionSpeed
              : undefined,
            strip: !!options.stripMetadata, // Must be a bool
          }),
        ],
      })
      .then(imageminBuffer => fs.writeFile(outputPath, imageminBuffer))
  )

const compressJpg = (pipeline, outputPath, options) =>
  pipeline.toBuffer().then(sharpBuffer =>
    imagemin
      .buffer(sharpBuffer, {
        plugins: [
          imageminMozjpeg({
            quality: options.quality,
            progressive: options.jpegProgressive,
          }),
        ],
      })
      .then(imageminBuffer => fs.writeFile(outputPath, imageminBuffer))
  )

const compressWebP = (pipeline, outputPath, options) =>
  pipeline.toBuffer().then(sharpBuffer =>
    imagemin
      .buffer(sharpBuffer, {
        plugins: [imageminWebp({ quality: options.quality })],
      })
      .then(imageminBuffer => fs.writeFile(outputPath, imageminBuffer))
  )

exports.createArgsDigest = args => {
  const filtered = _.pickBy(args, (value, key) => {
    // remove falsy
    if (!value) return false
    if (args.toFormat.match(/^jp*/) && _.includes(key, `png`)) {
      return false
    } else if (args.toFormat.match(/^png/) && key.match(/^jp*/)) {
      return false
    }
    // after initial processing - get rid of unknown/unneeded fields
    return argsWhitelist.includes(key)
  })

  const argsDigest = crypto
    .createHash(`md5`)
    .update(JSON.stringify(filtered, Object.keys(filtered).sort()))
    .digest(`hex`)

  const argsDigestShort = argsDigest.substr(argsDigest.length - 5)

  return argsDigestShort
}
