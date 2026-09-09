export function formatEtaSeconds(seconds: number | null | undefined): string | null {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null

    const s = Math.round(seconds)

    if (s < 60) return '<1 min'

    const minutes = Math.round(s / 60)
    if (minutes < 60) return `${minutes} min`

    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    return mins === 0 ? `${hours} hr` : `${hours} hr ${mins} min`
}

/**
 * Split an ETA label into the figure and its unit, for typography that gives
 * the number the weight it deserves.
 *
 * The reading is always "how many minutes", so the digits are the content and
 * "min" is a unit label — setting both at the same size makes the reader parse
 * a sentence when they wanted to parse a number. Handles the compound and
 * sub-minute forms too: "1 hr 20 min" keeps its whole value together, and
 * "<1 min" keeps the qualifier attached to the figure.
 */
export function splitEtaLabel(label: string | null): { value: string; unit: string } | null {
    if (!label) return null
    const m = /^(.*?)\s*(min|hr)$/.exec(label)
    if (!m) return { value: label, unit: '' }
    return { value: m[1], unit: m[2] }
}
