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
