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
    if (style.appliedTheme?.bg && style.appliedTheme?.fg) return {
        background: style.appliedTheme.bg,
        pageColors: {
            background: style.appliedTheme.bg,
            foreground: style.appliedTheme.fg,
        },
    }
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

const normalizeColor = value => {
    const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?/.exec(value ?? '')
    if (!match || match[4] === '0') return null
    return '#' + match.slice(1, 4)
        .map(x => Number(x).toString(16).padStart(2, '0')).join('')
}

const getAppliedColors = (doc, fallback = {}) => {
    const view = doc?.defaultView
    if (!view) return fallback
    const rootStyle = view.getComputedStyle(doc.documentElement)
    const bodyStyle = doc.body ? view.getComputedStyle(doc.body) : rootStyle
    const background = normalizeColor(bodyStyle.backgroundColor)
        ?? normalizeColor(rootStyle.backgroundColor)
        ?? fallback.background
    const foreground = normalizeColor(bodyStyle.color)
        ?? normalizeColor(rootStyle.color)
        ?? fallback.pageColors?.foreground
    return {
        background,
        pageColors: {
            background,
            foreground,
        },
    }
}

const hexToRGB = hex => {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex ?? '')
    if (!match) return null
    const n = parseInt(match[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const mix = (fg, bg, t) => Math.round(fg + (bg - fg) * t)

const recolorCanvas = (canvas, context, colors) => {
    const bg = hexToRGB(colors?.background)
    const fg = hexToRGB(colors?.pageColors?.foreground)
    if (!bg || !fg || colors.background === '#ffffff') return

    const image = context.getImageData(0, 0, canvas.width, canvas.height)
    const { data } = image
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        const saturation = max - min
        const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
        if (saturation > 32 && luminance < 0.95) continue
        data[i] = mix(fg[0], bg[0], luminance)
        data[i + 1] = mix(fg[1], bg[1], luminance)
        data[i + 2] = mix(fg[2], bg[2], luminance)
    }
    context.putImageData(image, 0, 0)
}

const applyAppearance = (doc, appearance) => {
    const { background, pageColors } = getPDFColors(doc, appearance)
    const style = doc?.documentElement?.style
    if (!style) return
    style.setProperty('--foliate-pdf-bg', background ?? '')
    style.setProperty('--foliate-pdf-fg', pageColors?.foreground ?? '')
    if (background) {
        style.setProperty('background', background, 'important')
        if (doc.body) doc.body.style.setProperty('background', background, 'important')
        for (const el of doc.querySelectorAll('#canvas, #canvas canvas'))
            el.style.setProperty('background', background, 'important')
    }
}

const render = async (page, doc, zoom, appearance, isCurrent = () => true) => {
    const scale = zoom * devicePixelRatio
    doc.documentElement.style.transform = `scale(${1 / devicePixelRatio})`
    doc.documentElement.style.transformOrigin = 'top left'
    doc.documentElement.style.setProperty('--scale-factor', scale)
    const viewport = page.getViewport({ scale })
    applyAppearance(doc, appearance)
    const fallbackColors = getPDFColors(doc, appearance)
    const { background, pageColors } = getAppliedColors(doc, fallbackColors)

    // the canvas must be in the `PDFDocument`'s `ownerDocument`
    // (`globalThis.document` by default); that's where the fonts are loaded
    const canvas = document.createElement('canvas')
    canvas.height = viewport.height
    canvas.width = viewport.width
    if (background) canvas.style.setProperty('background', background, 'important')
    const canvasContext = canvas.getContext('2d')
    await page.render({ canvasContext, viewport, background, pageColors }).promise
    recolorCanvas(canvas, canvasContext, { background, pageColors })
    if (!isCurrent()) return
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
    let renderID = 0
    let lastScale = 1
    const onZoom = ({ doc, scale, appearance }) => {
        lastScale = scale
        const id = ++renderID
        return render(page, doc, scale, appearance, () => id === renderID)
    }
    const onAppearance = ({ doc, appearance }) => {
        applyAppearance(doc, appearance)
        if (doc.querySelector('#canvas canvas')) return onZoom({
            doc,
            scale: lastScale,
            appearance,
        })
    }
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
