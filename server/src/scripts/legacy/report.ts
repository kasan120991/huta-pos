/**
 * Import report.
 *
 * A silent truncation reads as "we covered everything" when we did not. Every row the
 * import skips, deactivates, guesses at, or clamps has to end up here, so the output is
 * a work list for a human rather than a success message.
 */

export interface ReportSection {
  readonly title: string
  readonly note?: string
  readonly rows: string[]
}

export class ImportReport {
  private readonly counts = new Map<string, number>()
  private readonly sections = new Map<string, ReportSection>()

  count(entity: string, n = 1): void {
    this.counts.set(entity, (this.counts.get(entity) ?? 0) + n)
  }

  note(sectionTitle: string, row: string, note?: string): void {
    const existing = this.sections.get(sectionTitle)
    if (existing) {
      existing.rows.push(row)
      return
    }
    this.sections.set(sectionTitle, {
      title: sectionTitle,
      ...(note === undefined ? {} : { note }),
      rows: [row],
    })
  }

  render(): string {
    const lines: string[] = []
    lines.push('='.repeat(78))
    lines.push('HUTA POS — LEGACY CATALOG IMPORT REPORT')
    lines.push('='.repeat(78))
    lines.push('')

    lines.push('IMPORTED')
    lines.push('-'.repeat(78))
    for (const [entity, n] of [...this.counts.entries()].sort()) {
      lines.push(`  ${entity.padEnd(40, '.')} ${String(n).padStart(6)}`)
    }
    lines.push('')

    if (this.sections.size === 0) {
      lines.push('Nothing needed review.')
      return lines.join('\n')
    }

    lines.push('NEEDS REVIEW')
    lines.push('-'.repeat(78))
    lines.push('')
    for (const section of this.sections.values()) {
      lines.push(`${section.title}  (${section.rows.length})`)
      if (section.note) lines.push(`  ${section.note}`)
      for (const row of section.rows) lines.push(`    ${row}`)
      lines.push('')
    }
    return lines.join('\n')
  }
}
