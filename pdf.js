const pdfjsPath = path => new URL(`vendor/pdfjs/${path}`, import.meta.url).toString()

import './vendor/pdfjs/pdf.mjs'
const pdfjsLib = globalThis.pdfjsLib
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsPath('pdf.worker.mjs')

const fetchText = async url => await (await fetch(url)).text()

// https://raw.githubusercontent.com/mozilla/pdf.js/refs/tags/v5.5.207/web/text_layer_builder.css
const textLayerBuilderCSS = await fetchText(pdfjsPath('text_layer_builder.css'))

// https://raw.githubusercontent.com/mozilla/pdf.js/refs/tags/v5.5.207/web/annotation_layer_builder.css
const annotationLayerBuilderCSS = await fetchText(pdfjsPath('annotation_layer_builder.css'))

const getScheme = (doc, appearance) => appearance?.style?.colorScheme
    ?? (doc?.defaultView?.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light')

const getPDFColors = (doc, appearance) => {
    const style = appearance?.style
    if (!style || style.invert) return {}
    const colors = style.theme?.[getScheme(doc, appearance)]
    if (!colors?.bg || !colors?.fg) return {}
    return {
        background: colors.bg,
        pageColors: {
            background: colors.bg,
            foreground: colors.fg,
        },
    }
}

const hexToRGB = hex => {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex ?? '')
    if (!match) return null
    const n = parseInt(match[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const isDarkColor = color => {
    const rgb = hexToRGB(color)
    if (!rgb) return false
    const [r, g, b] = rgb.map(x => {
        const v = x / 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5
}

const applyCanvasAppearance = (canvas, background) => {
    if (!background) return
    canvas.style.backgroundColor = background
    if (background === '#ffffff') return
    if (isDarkColor(background)) {
        canvas.style.filter = 'invert(1) hue-rotate(180deg)'
        canvas.style.mixBlendMode = 'screen'
    } else canvas.style.mixBlendMode = 'multiply'
}

const applyAppearance = (doc, appearance) => {
    const { background, pageColors } = getPDFColors(doc, appearance)
    const style = doc?.documentElement?.style
    if (!style) return
    style.setProperty('--foliate-pdf-bg', background ?? '')
    style.setProperty('--foliate-pdf-fg', pageColors?.foreground ?? '')
    if (doc.body) doc.body.style.backgroundColor = background ?? ''
}

const render = async (page, doc, zoom, appearance) => {
    const scale = zoom * devicePixelRatio
    doc.documentElement.style.transform = `scale(${1 / devicePixelRatio})`
    doc.documentElement.style.transformOrigin = 'top left'
    doc.documentElement.style.setProperty('--scale-factor', scale)
    const viewport = page.getViewport({ scale })
    applyAppearance(doc, appearance)
    const { background, pageColors } = getPDFColors(doc, appearance)

    // the canvas must be in the `PDFDocument`'s `ownerDocument`
    // (`globalThis.document` by default); that's where the fonts are loaded
    const canvas = document.createElement('canvas')
    canvas.height = viewport.height
    canvas.width = viewport.width
    const canvasContext = canvas.getContext('2d')
    await page.render({ canvasContext, viewport, background, pageColors }).promise
    applyCanvasAppearance(canvas, background)
    doc.querySelector('#canvas').replaceChildren(doc.adoptNode(canvas))

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
            background: var(--foliate-pdf-bg, transparent);
            color: var(--foliate-pdf-fg, CanvasText);
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
    const onAppearance = ({ doc, appearance }) => applyAppearance(doc, appearance)
    return { src, onZoom, onAppearance }
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

    const book = { rendition: { layout: 'pre-paginated' } }

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
    book.destroy = () => pdf.destroy()
    return book
}
