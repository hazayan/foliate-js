const parseViewport = str => str
    ?.split(/[,;\s]/) // NOTE: technically, only the comma is valid
    ?.filter(x => x)
    ?.map(x => x.split('=').map(x => x.trim()))

const getViewport = (doc, viewport) => {
    // use `viewBox` for SVG
    if (doc.documentElement.localName === 'svg') {
        const [, , width, height] = doc.documentElement
            .getAttribute('viewBox')?.split(/\s/) ?? []
        return { width, height }
    }

    // get `viewport` `meta` element
    const meta = parseViewport(doc.querySelector('meta[name="viewport"]')
        ?.getAttribute('content'))
    if (meta) return Object.fromEntries(meta)

    // fallback to book's viewport
    if (typeof viewport === 'string') return parseViewport(viewport)
    if (viewport?.width && viewport.height) return viewport

    // if no viewport (possibly with image directly in spine), get image size
    const img = doc.querySelector('img')
    if (img) return { width: img.naturalWidth, height: img.naturalHeight }

    // just show *something*, i guess...
    console.warn(new Error('Missing viewport properties'))
    return { width: 1000, height: 2000 }
}

const yieldToUI = () => new Promise(resolve => setTimeout(resolve, 0))

export class FixedLayout extends HTMLElement {
    static observedAttributes = ['flow', 'zoom', 'max-column-count']
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => this.#render())
    #spreads
    #index = -1
    defaultViewport
    spread
    #portrait = false
    #left
    #right
    #center
    #side
    #flow
    #zoom
    #appearance
    #appearanceVersion = 0
    #scrolledFrames
    #scrolledToken
    #scrolledBuild
    #scrolledRenderFrame
    #unloadFrame(frame) {
        if (!frame || frame.blank) return
        frame.iframe?.removeAttribute('src')
        this.book?.sections?.[frame.index]?.unload?.()
    }
    #unloadFrames() {
        if (this.#scrolledFrames) {
            for (const frame of this.#scrolledFrames) this.#unloadFrame(frame)
        } else {
            this.#unloadFrame(this.#left)
            this.#unloadFrame(this.#right)
            this.#unloadFrame(this.#center)
        }
        this.#left = null
        this.#right = null
        this.#center = null
        this.#scrolledFrames = null
        this.#scrolledBuild = null
    }
    constructor() {
        super()

        const sheet = new CSSStyleSheet()
        this.#root.adoptedStyleSheets = [sheet]
        sheet.replaceSync(`:host {
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: safe center;
            align-items: center;
            overflow: auto;
            scrollbar-gutter: stable both-edges;
            gap: 16px;
            box-sizing: border-box;
        }
        :host([flow="scrolled"]) {
            flex-direction: column;
            justify-content: flex-start;
            padding: 16px;
        }`)

        this.#observer.observe(this)
        this.addEventListener('scroll', () => {
            if (this.scrolled) {
                this.#reportScrolledLocation('scroll')
                this.#scheduleScrolledRender()
            }
        })
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'flow':
                this.#flow = value
                if (this.scrolled) this.#showScrolled()
                else if (this.#index >= 0) this.goToSpread(this.#index, this.#side)
                break
            case 'zoom':
                this.#zoom = value !== 'fit-width' && value !== 'fit-page'
                    ? parseFloat(value) : value
                this.#render()
                break
            case 'max-column-count':
                this.#render()
                break
        }
    }
    async #createFrame({ index, src: srcOption }) {
        const srcOptionIsString = typeof srcOption === 'string'
        const src = srcOptionIsString ? srcOption : srcOption?.src
        const onZoom = srcOptionIsString ? null : srcOption?.onZoom
        const element = document.createElement('div')
        element.setAttribute('dir', 'ltr')
        const iframe = document.createElement('iframe')
        element.append(iframe)
        Object.assign(iframe.style, {
            border: '0',
            display: 'none',
            overflow: 'hidden',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        iframe.setAttribute('scrolling', 'no')
        iframe.setAttribute('part', 'filter')
        this.#root.append(element)
        if (!src) return { blank: true, element, iframe }
        return new Promise(resolve => {
            iframe.addEventListener('load', () => {
                const doc = iframe.contentDocument
                this.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
                const { width, height } = getViewport(doc, this.defaultViewport)
                resolve({
                    element, iframe,
                    width: parseFloat(width),
                    height: parseFloat(height),
                    onZoom,
                })
            }, { once: true })
            iframe.src = src
        })
    }
    get scrolled() {
        return this.#flow === 'scrolled'
    }
    #getZoomFactor() {
        const value = parseFloat(getComputedStyle(this).getPropertyValue('--pdf-font-scale'))
        return value && !isNaN(value) ? value : 1
    }
    #getScale(frame, width = this.clientWidth, height = this.clientHeight) {
        const maxCols = parseInt(this.getAttribute('max-column-count'))
        const portrait = maxCols === 1
            || (this.spread !== 'both' && this.spread !== 'portrait' && height > width)
        const left = this.#left ?? {}
        const right = this.#center ?? this.#right ?? {}
        const target = this.#side === 'left' ? left : right
        const blankWidth = left.width ?? right.width ?? frame?.width ?? 0
        const blankHeight = left.height ?? right.height ?? frame?.height ?? 0

        const scale = typeof this.#zoom === 'number' && !isNaN(this.#zoom)
            ? this.#zoom
            : this.#zoom === 'fit-width'
                ? this.scrolled
                    ? width / (frame?.width ?? blankWidth)
                    : (portrait || this.#center
                        ? width / (target.width ?? blankWidth)
                        : width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)))
                : this.scrolled
                    ? width / (frame?.width ?? blankWidth)
                    : (portrait || this.#center
                        ? Math.min(
                            width / (target.width ?? blankWidth),
                            height / (target.height ?? blankHeight))
                        : Math.min(
                            width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)),
                            height / Math.max(
                                left.height ?? blankHeight,
                                right.height ?? blankHeight)))
            || 1
        return scale * this.#getZoomFactor()
    }
    #transformFrame(frame, scale, display = 'block', renderContent = true) {
        let { element, iframe, width, height, blank, onZoom } = frame
        if (!iframe) return
        if (onZoom && renderContent) {
            const renderKey = `${scale}:${this.#appearanceVersion}`
            if (frame.renderKey !== renderKey) {
                frame.renderKey = renderKey
                onZoom({
                    doc: frame.iframe.contentDocument,
                    scale,
                    appearance: this.#appearance,
                })
            }
        }
        const iframeScale = onZoom ? scale : 1
        Object.assign(iframe.style, {
            width: `${width * iframeScale}px`,
            height: `${height * iframeScale}px`,
            transform: onZoom ? 'none' : `scale(${scale})`,
            transformOrigin: 'top left',
            display: blank ? 'none' : 'block',
        })
        Object.assign(element.style, {
            width: `${width * scale}px`,
            height: `${height * scale}px`,
            overflow: 'hidden',
            display,
            flexShrink: '0',
            marginBlock: 'auto',
        })
    }
    #render(side = this.#side) {
        if (this.scrolled) {
            this.#scheduleScrolledRender()
            return
        }
        if (!side) return
        const left = this.#left ?? {}
        const right = this.#center ?? this.#right ?? {}
        const target = side === 'left' ? left : right
        const width = this.clientWidth
        const height = this.clientHeight
        const maxCols = parseInt(this.getAttribute('max-column-count'))
        const portrait = maxCols === 1
            || (this.spread !== 'both' && this.spread !== 'portrait' && height > width)
        this.#portrait = portrait
        const scale = this.#getScale(target, width, height)

        const transform = frame => {
            this.#transformFrame(frame, scale)
            if (portrait && frame !== target) {
                frame.element.style.display = 'none'
            }
        }
        if (this.#center) {
            transform(this.#center)
        } else {
            transform(left)
            transform(right)
        }
    }
    #renderScrolled() {
        if (!this.#scrolledFrames) return
        const width = Math.max(1, this.clientWidth - 32)
        for (const frame of this.#scrolledFrames) {
            const scale = this.#getScale(frame, width, this.clientHeight)
            this.#transformFrame(frame, scale, 'block', this.#isFrameNearViewport(frame))
        }
    }
    #isFrameNearViewport(frame) {
        if (!frame?.element?.isConnected) return false
        const rect = frame.element.getBoundingClientRect()
        const root = this.getBoundingClientRect()
        const margin = Math.max(root.height, this.clientHeight || 0)
        return rect.bottom >= root.top - margin && rect.top <= root.bottom + margin
    }
    #scheduleScrolledRender() {
        if (this.#scrolledRenderFrame) return
        this.#scrolledRenderFrame = requestAnimationFrame(() => {
            this.#scrolledRenderFrame = null
            this.#renderScrolled()
        })
    }
    async #showScrolled(targetIndex = 0) {
        if (!this.book || this.#scrolledFrames) {
            this.#renderScrolled()
            let frame = this.#scrolledFrames?.find(frame => frame.index === targetIndex)
            while (!frame && this.#scrolledBuild) {
                await yieldToUI()
                frame = this.#scrolledFrames?.find(frame => frame.index === targetIndex)
            }
            return frame
        }
        const token = Symbol()
        this.#scrolledToken = token
        this.#unloadFrames()
        this.#root.replaceChildren()
        const frames = []
        this.#scrolledFrames = frames

        let resolveTarget
        const targetReady = new Promise(resolve => {
            resolveTarget = resolve
        })
        const build = (async () => {
            let targetResolved = false
            for (let index = 0; index < this.book.sections.length; index++) {
                if (this.#scrolledToken !== token) {
                    for (const frame of frames) this.#unloadFrame(frame)
                    return
                }
                const section = this.book.sections[index]
                const src = await section.load?.()
                const frame = { ...await this.#createFrame({ index, src }), index }
                frames.push(frame)

                if (index === 0) {
                    this.#index = 0
                    this.#renderScrolled()
                    this.#reportScrolledLocation()
                } else this.#transformFrame(frame, this.#getScale(
                    frame,
                    Math.max(1, this.clientWidth - 32),
                    this.clientHeight))

                if (index === targetIndex) {
                    targetResolved = true
                    resolveTarget(frame)
                }
                await yieldToUI()
            }
            if (this.#scrolledToken !== token) {
                for (const frame of frames) this.#unloadFrame(frame)
                return
            }
            if (!targetResolved) resolveTarget(frames[0])
            this.#renderScrolled()
            this.#reportScrolledLocation()
        })()
        this.#scrolledBuild = build.finally(() => {
            if (this.#scrolledToken === token) this.#scrolledBuild = null
        })
        return targetReady
    }
    async #showSpread({ left, right, center, side }) {
        this.#scrolledToken = null
        this.#unloadFrames()
        this.#root.replaceChildren()
        if (center) {
            this.#center = await this.#createFrame(center)
            this.#side = 'center'
            this.#render()
        } else {
            this.#left = await this.#createFrame(left)
            this.#right = await this.#createFrame(right)
            this.#side = this.#left.blank ? 'right'
                : this.#right.blank ? 'left' : side
            this.#render()
        }
    }
    #goLeft() {
        if (this.#center || this.#left?.blank) return
        if (this.#portrait && this.#left?.element?.style?.display === 'none') {
            this.#side = 'left'
            this.#render()
            this.#reportLocation('page')
            return true
        }
    }
    #goRight() {
        if (this.#center || this.#right?.blank) return
        if (this.#portrait && this.#right?.element?.style?.display === 'none') {
            this.#side = 'right'
            this.#render()
            this.#reportLocation('page')
            return true
        }
    }
    open(book) {
        this.book = book
        const { rendition } = book
        this.spread = rendition?.spread
        this.defaultViewport = rendition?.viewport

        const rtl = book.dir === 'rtl'
        const ltr = !rtl
        this.rtl = rtl

        if (rendition?.spread === 'none')
            this.#spreads = book.sections.map(section => ({ center: section }))
        else this.#spreads = book.sections.reduce((arr, section, i) => {
            const last = arr[arr.length - 1]
            const { pageSpread } = section
            const newSpread = () => {
                const spread = {}
                arr.push(spread)
                return spread
            }
            if (pageSpread === 'center') {
                const spread = last.left || last.right ? newSpread() : last
                spread.center = section
            }
            else if (pageSpread === 'left') {
                const spread = last.center || last.left || ltr && i ? newSpread() : last
                spread.left = section
            }
            else if (pageSpread === 'right') {
                const spread = last.center || last.right || rtl && i ? newSpread() : last
                spread.right = section
            }
            else if (ltr) {
                if (last.center || last.right) newSpread().left = section
                else if (last.left || !i) last.right = section
                else last.left = section
            }
            else {
                if (last.center || last.left) newSpread().right = section
                else if (last.right || !i) last.left = section
                else last.right = section
            }
            return arr
        }, [{}])
    }
    async respread() {
        if (!this.book) return
        const section = this.#index !== -1 ? this.book.sections[this.index] : null
        this.open(this.book)
        if (section) {
            const target = this.getSpreadOf(section)
            if (!target) return
            this.#index = -1
            return this.goToSpread(target.index, target.side, 'page')
        }
    }
    setAppearance(appearance) {
        this.#appearance = appearance
        this.#appearanceVersion++
        this.#render()
    }
    get index() {
        const spread = this.#spreads[this.#index]
        const section = spread?.center ?? (this.#side === 'left'
            ? spread.left ?? spread.right : spread.right ?? spread.left)
        return this.book.sections.indexOf(section)
    }
    #reportLocation(reason) {
        this.dispatchEvent(new CustomEvent('relocate', { detail:
            { reason, range: null, index: this.index, fraction: 0, size: 1 } }))
    }
    getSpreadOf(section) {
        const spreads = this.#spreads
        for (let index = 0; index < spreads.length; index++) {
            const { left, right, center } = spreads[index]
            if (left === section) return { index, side: 'left' }
            if (right === section) return { index, side: 'right' }
            if (center === section) return { index, side: 'center' }
        }
    }
    async goToSpread(index, side, reason) {
        if (index < 0 || index > this.#spreads.length - 1) return
        if (index === this.#index) {
            this.#render(side)
            return
        }
        this.#index = index
        const spread = this.#spreads[index]
        if (spread.center) {
            const index = this.book.sections.indexOf(spread.center)
            const src = await spread.center?.load?.()
            await this.#showSpread({ center: { index, src } })
        } else {
            const indexL = this.book.sections.indexOf(spread.left)
            const indexR = this.book.sections.indexOf(spread.right)
            const srcL = await spread.left?.load?.()
            const srcR = await spread.right?.load?.()
            const left = { index: indexL, src: srcL }
            const right = { index: indexR, src: srcR }
            await this.#showSpread({ left, right, side })
        }
        this.#reportLocation(reason)
    }
    async select(target) {
        await this.goTo(target)
    }
    async goTo(target) {
        const { book } = this
        const resolved = await target
        const section = book.sections[resolved.index]
        if (!section) return
        if (this.scrolled) {
            const frame = await this.#showScrolled(resolved.index)
            frame?.element.scrollIntoView({ block: 'start' })
            this.#reportScrolledLocation()
            return
        }
        const { index, side } = this.getSpreadOf(section)
        await this.goToSpread(index, side)
        if (resolved.select && resolved.anchor) {
            for (const frame of this.#root.querySelectorAll('iframe')) {
                const doc = frame.contentDocument
                if (!doc) continue
                try {
                    const range = typeof resolved.anchor === 'function' ? resolved.anchor(doc) : resolved.anchor
                    if (range) {
                        const sel = doc.defaultView.getSelection()
                        sel.removeAllRanges()
                        sel.addRange(range)
                    }
                } catch (e) {}
            }
        }
    }
    async next() {
        if (this.scrolled) return this.scrollBy({ top: this.clientHeight * 0.9, behavior: 'smooth' })
        const s = this.rtl ? this.#goLeft() : this.#goRight()
        if (!s) return this.goToSpread(this.#index + 1, this.rtl ? 'right' : 'left', 'page')
    }
    async prev() {
        if (this.scrolled) return this.scrollBy({ top: -this.clientHeight * 0.9, behavior: 'smooth' })
        const s = this.rtl ? this.#goRight() : this.#goLeft()
        if (!s) return this.goToSpread(this.#index - 1, this.rtl ? 'left' : 'right', 'page')
    }
    #reportScrolledLocation(reason) {
        const frames = this.#scrolledFrames
        if (!frames?.length) return
        const rootRect = this.getBoundingClientRect()
        const middle = rootRect.top + rootRect.height / 2
        const current = frames.find(frame => {
            const rect = frame.element.getBoundingClientRect()
            return rect.top <= middle && rect.bottom >= middle
        }) ?? frames[0]
        this.#index = current.index
        this.dispatchEvent(new CustomEvent('relocate', { detail:
            { reason, range: null, index: current.index, fraction: 0, size: 1 } }))
    }
    getContents() {
        return Array.from(this.#root.querySelectorAll('iframe'), frame => ({
            doc: frame.contentDocument,
            // TODO: index, overlayer
        }))
    }
    destroy() {
        this.#observer.unobserve(this)
        this.#scrolledToken = null
        if (this.#scrolledRenderFrame) cancelAnimationFrame(this.#scrolledRenderFrame)
        this.#scrolledRenderFrame = null
        this.#unloadFrames()
        this.#root.replaceChildren()
        this.book = null
    }
}

customElements.define('foliate-fxl', FixedLayout)
