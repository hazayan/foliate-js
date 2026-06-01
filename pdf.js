const pdfjsPath = path => new URL(`vendor/pdfjs/${path}`, import.meta.url).toString()

import './vendor/pdfjs/pdf.mjs'
const pdfjsLib = globalThis.pdfjsLib
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsPath('pdf.worker.mjs')

const fetchText = async url => await (await fetch(url)).text()

// https://raw.githubusercontent.com/mozilla/pdf.js/refs/tags/v5.5.207/web/text_layer_builder.css
const textLayerBuilderCSS = await fetchText(pdfjsPath('text_layer_builder.css'))

// https://raw.githubusercontent.com/mozilla/pdf.js/refs/tags/v5.5.207/web/annotation_layer_builder.css
const annotationLayerBuilderCSS = await fetchText(pdfjsPath('annotation_layer_builder.css'))

const getPageColors = appearance => {
    const { style } = appearance ?? {}
    const { theme, colorScheme } = style ?? {}
    const palette = colorScheme === 'dark'
        ? (style?.invert ? theme?.inverted : theme?.dark)
        : theme?.light
    const background = palette?.bg
    const foreground = palette?.fg
    if (!background || !foreground) return {}
    if (background === '#ffffff' && foreground === '#000000') return {}
    return {
        background,
        pageColors: { background, foreground },
    }
}

const applyAppearance = (doc, appearance) => {
    const colors = getPageColors(appearance)
    const { background, pageColors } = colors
    if (!background) return colors
    const foreground = pageColors?.foreground
    for (const element of [
        doc.documentElement,
        doc.body,
        doc.querySelector('#canvas'),
    ].filter(Boolean)) {
        element.style.background = background
        if (foreground) element.style.color = foreground
    }
    doc.documentElement.style.setProperty('--pdf-page-background', background)
    if (foreground) doc.documentElement.style.setProperty('--pdf-page-foreground', foreground)
    return colors
}

const cssColorToRGB = color => {
    const context = document.createElement('canvas').getContext('2d')
    context.fillStyle = color
    const normalized = context.fillStyle
    if (normalized.startsWith('#')) {
        const hex = normalized.slice(1)
        const step = hex.length === 3 ? 1 : 2
        const expand = x => step === 1 ? x + x : x
        return [0, step, step * 2].map(i => parseInt(expand(hex.slice(i, i + step)), 16))
    }
    return normalized.match(/\d+/g)?.slice(0, 3).map(Number)
}

const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve))

const isNearWhite = (data, offset = 0) =>
    data[offset + 3] && data[offset] >= 245 && data[offset + 1] >= 245 && data[offset + 2] >= 245

const shouldRecolorWhitePage = (canvas, context) => {
    const { width, height } = canvas
    if (!width || !height) return false

    const samples = [
        [0.08, 0.08], [0.5, 0.08], [0.92, 0.08],
        [0.08, 0.5], [0.92, 0.5],
        [0.08, 0.92], [0.5, 0.92], [0.92, 0.92],
    ]
    let white = 0
    for (const [x, y] of samples) {
        const px = Math.min(width - 1, Math.max(0, Math.floor(width * x)))
        const py = Math.min(height - 1, Math.max(0, Math.floor(height * y)))
        try {
            if (isNearWhite(context.getImageData(px, py, 1, 1).data)) white++
        } catch {
            return false
        }
    }
    return white >= Math.ceil(samples.length * 0.75)
}

const recolorWhitePage = async (canvas, background, isCurrent) => {
    if (!background || background === '#ffffff') return
    const rgb = cssColorToRGB(background)
    if (!rgb) return

    await nextFrame()
    await nextFrame()
    if (!isCurrent()) return

    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!shouldRecolorWhitePage(canvas, context)) return

    const rowsPerBatch = 128
    for (let y = 0; y < canvas.height; y += rowsPerBatch) {
        if (!isCurrent()) return
        const height = Math.min(rowsPerBatch, canvas.height - y)
        const image = context.getImageData(0, y, canvas.width, height)
        const data = image.data
        let changed = false
        for (let i = 0; i < data.length; i += 4) {
            if (isNearWhite(data, i)) {
                data[i] = rgb[0]
                data[i + 1] = rgb[1]
                data[i + 2] = rgb[2]
                changed = true
            }
        }
        if (changed) context.putImageData(image, 0, y)
        await nextFrame()
    }
}

const render = async (page, doc, zoom, appearance) => {
    const renderKey = Symbol()
    doc._pdfRenderKey = renderKey
    const scale = zoom * devicePixelRatio
    doc.documentElement.style.transform = `scale(${1 / devicePixelRatio})`
    doc.documentElement.style.transformOrigin = 'top left'
    doc.documentElement.style.setProperty('--scale-factor', scale)
    const viewport = page.getViewport({ scale })
    const { background, pageColors } = applyAppearance(doc, appearance)

    // the canvas must be in the `PDFDocument`'s `ownerDocument`
    // (`globalThis.document` by default); that's where the fonts are loaded
    const canvas = document.createElement('canvas')
    canvas.height = viewport.height
    canvas.width = viewport.width
    const canvasContext = canvas.getContext('2d')
    await page.render({ canvasContext, viewport, background, pageColors }).promise
    if (doc._pdfRenderKey !== renderKey) return
    canvas.style.background = background ?? ''
    const canvasHost = doc.querySelector('#canvas')
    if (background) canvasHost.style.background = background
    canvasHost.replaceChildren(doc.adoptNode(canvas))
    void recolorWhitePage(canvas, background, () => doc._pdfRenderKey === renderKey && canvas.isConnected)

    if (doc._textLayer) doc._textLayer.update({ viewport })
    else {
        const container = doc.querySelector('.textLayer')
        container.replaceChildren()
        const textLayer = new pdfjsLib.TextLayer({
            textContentSource: await page.streamTextContent(),
            container, viewport,
        })
        await textLayer.render()
        doc._textLayer = textLayer

        // fix text selection
        // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/text_layer_builder.js#L105-L107
        const endOfContent = document.createElement('div')
        endOfContent.className = 'endOfContent'
        container.append(endOfContent)
        // TODO: this only works in Firefox; see https://github.com/mozilla/pdf.js/pull/17923
        container.onpointerdown = () => container.classList.add('selecting')
        container.onpointerup = () => container.classList.remove('selecting')
    }

    // hide "offscreen" canvases appended to docuemnt when rendering text layer
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/pdf_viewer.css#L51-L58
    for (const canvas of document.querySelectorAll('.hiddenCanvasElement'))
        Object.assign(canvas.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '0',
            height: '0',
            display: 'none',
        })

    if (doc._annotationLayer) doc._annotationLayer.update({ viewport })
    else {
        const div = doc.querySelector('.annotationLayer')
        const linkService = {
            goToDestination: () => {},
            getDestinationHash: dest => JSON.stringify(dest),
            addLinkAttributes: (link, url) => link.href = url,
        }
        const annotationLayer = new pdfjsLib.AnnotationLayer({ page, viewport, div, linkService })
        await annotationLayer.render({ annotations: await page.getAnnotations() })
        doc._annotationLayer = annotationLayer
    }
}

const renderPage = async (page, getImageBlob) => {
    const viewport = page.getViewport({ scale: 1 })
    if (getImageBlob) {
        const canvas = document.createElement('canvas')
        canvas.height = viewport.height
        canvas.width = viewport.width
        const canvasContext = canvas.getContext('2d')
        await page.render({ canvasContext, viewport }).promise
        return new Promise(resolve => canvas.toBlob(resolve))
    }
    const src = URL.createObjectURL(new Blob([`
        <!DOCTYPE html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=${viewport.width}, height=${viewport.height}">
        <style>
        html, body {
            margin: 0;
            padding: 0;
            background: var(--pdf-page-background, transparent);
            color: var(--pdf-page-foreground, CanvasText);
        }
        #canvas {
            background: var(--pdf-page-background, transparent);
        }
        #canvas canvas {
            display: block;
        }
        /*
        https://github.com/mozilla/pdf.js/commit/bd05b255fabfc313b194bfe9a17ccded4d90fb5a
        */
        :root {
          --user-unit: 1;
          --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
          --scale-round-x: 1px;
          --scale-round-y: 1px;
        }
        ${textLayerBuilderCSS}
        ${annotationLayerBuilderCSS}
        </style>
        <div id="canvas"></div>
        <div class="textLayer"></div>
        <div class="annotationLayer"></div>
    `], { type: 'text/html' }))
    const onZoom = ({ doc, scale, appearance }) => render(page, doc, scale, appearance)
    return { src, onZoom }
}

const makeTOCItem = item => ({
    label: item.title,
    href: JSON.stringify(item.dest),
    subitems: item.items.length ? item.items.map(makeTOCItem) : null,
})

export const makePDF = async file => {
    const transport = new pdfjsLib.PDFDataRangeTransport(file.size, [])
    transport.requestDataRange = (begin, end) => {
        file.slice(begin, end).arrayBuffer().then(chunk => {
            transport.onDataRange(begin, chunk)
        })
    }
    const pdf = await pdfjsLib.getDocument({
        range: transport,
        cMapUrl: pdfjsPath('cmaps/'),
        standardFontDataUrl: pdfjsPath('standard_fonts/'),
        isEvalSupported: false,
    }).promise

    const book = { rendition: { layout: 'pre-paginated' }, isPDF: true }

    const { metadata, info } = await pdf.getMetadata() ?? {}
    // TODO: for better results, parse `metadata.getRaw()`
    book.metadata = {
        title: metadata?.get('dc:title') ?? info?.Title,
        author: metadata?.get('dc:creator') ?? info?.Author,
        contributor: metadata?.get('dc:contributor'),
        description: metadata?.get('dc:description') ?? info?.Subject,
        language: metadata?.get('dc:language'),
        publisher: metadata?.get('dc:publisher'),
        subject: metadata?.get('dc:subject'),
        identifier: metadata?.get('dc:identifier'),
        source: metadata?.get('dc:source'),
        rights: metadata?.get('dc:rights'),
    }

    const outline = await pdf.getOutline()
    book.toc = outline?.map(makeTOCItem)

    const cache = new Map()
    book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
        id: i,
        load: async () => {
            const cached = cache.get(i)
            if (cached) return cached
            const url = await renderPage(await pdf.getPage(i + 1))
            cache.set(i, url)
            return url
        },
        unload: () => {
            const cached = cache.get(i)
            if (!cached) return
            URL.revokeObjectURL(cached.src ?? cached)
            cache.delete(i)
        },
        createDocument: async () => {
            const page = await pdf.getPage(i + 1)
            const doc = document.implementation.createHTMLDocument()
            // mirror the rendered iframe structure so search CFIs resolve
            const canvasDiv = doc.createElement('div')
            canvasDiv.id = 'canvas'
            const textLayer = doc.createElement('div')
            textLayer.className = 'textLayer'
            const annotationLayer = doc.createElement('div')
            annotationLayer.className = 'annotationLayer'
            doc.body.append(canvasDiv, textLayer, annotationLayer)
            const viewport = page.getViewport({ scale: 1 })
            await new pdfjsLib.TextLayer({
                textContentSource: await page.streamTextContent(),
                container: textLayer,
                viewport,
            }).render()
            return doc
        },
        size: 1000,
    }))
    book.isExternal = uri => /^\w+:/i.test(uri)
    book.resolveHref = async href => {
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        const index = await pdf.getPageIndex(dest[0])
        return { index }
    }
    book.splitTOCHref = async href => {
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        const index = await pdf.getPageIndex(dest[0])
        return [index, null]
    }
    book.getTOCFragment = doc => doc.documentElement
    book.getCover = async () => renderPage(await pdf.getPage(1), true)
    book.destroy = () => {
        for (const section of book.sections) section.unload?.()
        pdf.destroy()
    }
    return book
}
