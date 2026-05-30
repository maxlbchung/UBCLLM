// Right-sidebar program selector + requirements progress. Two render
// modes driven by lib/programRequirements:
//   - structured (Track B overlay): per-category credit progress bars
//   - prose (default today):       checklist of referenced courses +
//                                  collapsible raw text from the calendar
import { useEffect, useMemo, useState } from 'react'
import {
  getProgramIndex,
  getRequirementsFor,
  optionMatches,
  type ProgramIndex,
  type ProgramOption,
  type ProgramRequirements,
} from '../../lib/programRequirements'
import { usePlanner } from '../../store/planner'
import type { Chunk } from '../../lib/retrieve'
import { parseCourseChunk } from '../../lib/retrieve'
import { playSfx } from '../../lib/sfx'
import { parseProgramYears, hasYearRequirements } from '../../lib/programYears'
import { YearRequirements } from './YearRequirements'
import { CheckIcon, CircleIcon, ExternalLinkIcon } from '../icons'

interface ProgramRequirementsProps {
  courseIndex: Map<string, Chunk>
  plannedCodes: Set<string>
}

function creditValue(chunk: Chunk | undefined): number {
  if (!chunk) return 0
  const m = chunk.text.match(/Credits:\s*(\d+)/)
  return m ? Number(m[1]) : 0
}

// Program selectors (Faculty / Major / Minor) — lives in the Prefs tab. Writes
// the selection to the planner store; the Progress tab (ProgramProgress) reads
// it to resolve and render the requirements.
export function ProgramSelectors() {
  const faculty = usePlanner((s) => s.faculty)
  const major = usePlanner((s) => s.major)
  const minor = usePlanner((s) => s.minor)
  const setProgram = usePlanner((s) => s.setProgram)

  const [index, setIndex] = useState<ProgramIndex | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getProgramIndex()
      .then((idx) => {
        if (!cancelled) setIndex(idx)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(String(err?.message ?? err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const majorOptions: ProgramOption[] = useMemo(() => {
    if (!index || !faculty) return []
    return index.majorsByFaculty.get(faculty) ?? []
  }, [index, faculty])

  const minorOptions: ProgramOption[] = useMemo(() => {
    if (!index || !faculty) return []
    return index.minorsByFaculty.get(faculty) ?? []
  }, [index, faculty])

  if (loadError) {
    return (
      <div className="text-sm text-danger-fg">
        Couldn’t load program index: {loadError}
      </div>
    )
  }
  if (!index) {
    return <div className="text-sm text-fg-faint">Loading programs…</div>
  }

  return (
    <div className="flex flex-col gap-2 min-h-0">
      <h3 className="text-sm font-semibold text-fg">Program</h3>
      <div className="flex flex-col gap-2 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-muted">Faculty</span>
          <select
            value={faculty ?? ''}
            onChange={(e) => {
              const value = e.target.value || null
              setProgram('faculty', value)
              setProgram('major', null)
              setProgram('minor', null)
              playSfx('click')
            }}
            className="bg-input border border-line-soft text-fg rounded px-2 py-1 text-sm focus:outline-none focus:border-fg-faint"
          >
            <option value="">— Select faculty —</option>
            {index.faculties.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-muted">Major / program</span>
          <select
            value={major ?? ''}
            onChange={(e) => { setProgram('major', e.target.value || null); playSfx('click') }}
            disabled={!faculty}
            className="bg-input border border-line-soft text-fg rounded px-2 py-1 text-sm focus:outline-none focus:border-fg-faint disabled:opacity-50"
          >
            <option value="">— Select major —</option>
            {majorOptions.map((opt) => (
              <option key={opt.url} value={opt.url}>
                {opt.label}
              </option>
            ))}
          </select>
          {major && (
            <a
              href={major}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => playSfx('click')}
              className="flex items-center gap-1 text-xs text-accent hover:underline"
            >
              <ExternalLinkIcon className="w-3.5 h-3.5" />
              UBC Calendar page
            </a>
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-muted">Minor (optional)</span>
          <select
            value={minor ?? ''}
            onChange={(e) => { setProgram('minor', e.target.value || null); playSfx('click') }}
            disabled={!faculty}
            className="bg-input border border-line-soft text-fg rounded px-2 py-1 text-sm focus:outline-none focus:border-fg-faint disabled:opacity-50"
          >
            <option value="">— Select minor —</option>
            {minorOptions.map((opt) => (
              <option key={opt.url} value={opt.url}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}

// Requirements display (the progress bar + year-by-year course checklist) —
// lives in the Progress tab. Reads the selected major from the store and
// resolves its requirements; falls back to a hint until a major is picked.
export function ProgramProgress({
  courseIndex,
  plannedCodes,
}: ProgramRequirementsProps) {
  const major = usePlanner((s) => s.major)
  const [requirements, setRequirements] =
    useState<ProgramRequirements | null>(null)

  // Re-resolve requirements whenever major changes.
  useEffect(() => {
    let cancelled = false
    if (!major) {
      // Defer the clear off the render path so the lint rule against
      // setState-in-effect-body stays happy; the user-visible effect is
      // identical since we run before paint.
      queueMicrotask(() => {
        if (!cancelled) setRequirements(null)
      })
      return () => {
        cancelled = true
      }
    }
    getRequirementsFor(major).then((req) => {
      if (!cancelled) setRequirements(req)
    })
    return () => {
      cancelled = true
    }
  }, [major])

  if (!major) {
    return (
      <div className="text-sm text-fg-faint">
        Select a major in the Info tab to see program requirements.
      </div>
    )
  }
  if (!requirements) {
    return <div className="text-sm text-fg-faint">Loading requirements…</div>
  }
  return (
    <div className="flex flex-col gap-2 min-h-0">
      <RequirementsPanel
        req={requirements}
        courseIndex={courseIndex}
        plannedCodes={plannedCodes}
      />
    </div>
  )
}

function RequirementsPanel({
  req,
  courseIndex,
  plannedCodes,
}: {
  req: ProgramRequirements
  courseIndex: Map<string, Chunk>
  plannedCodes: Set<string>
}) {
  if (req.kind === 'structured') {
    return (
      <div className="flex flex-col gap-3">
        {typeof req.total_credits === 'number' && (
          <TotalCreditsBar
            earned={Array.from(plannedCodes).reduce(
              (sum, c) => sum + creditValue(courseIndex.get(c)),
              0,
            )}
            required={req.total_credits}
          />
        )}
        <ul className="flex flex-col gap-2">
          {req.categories.map((cat) => {
            const matchingCodes = Array.from(plannedCodes).filter((c) =>
              cat.options.some((opt) => optionMatches(opt, c)),
            )
            const earned = matchingCodes.reduce((sum, c) => {
              const opt = cat.options.find((o) => optionMatches(o, c))
              return (
                sum +
                (opt?.credit_value ?? creditValue(courseIndex.get(c)) ?? 0)
              )
            }, 0)
            return (
              <li
                key={cat.name}
                className="rounded border border-line bg-surface-soft p-2 flex flex-col gap-1"
              >
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-fg">{cat.name}</span>
                  <span className="text-xs text-fg-muted">
                    {earned}/{cat.credits_required} cr
                  </span>
                </div>
                <ProgressBar earned={earned} required={cat.credits_required} />
                {cat.notes && (
                  <p className="text-xs text-fg-faint">{cat.notes}</p>
                )}
                {matchingCodes.length > 0 && (
                  <p className="text-xs text-fg-muted">
                    {matchingCodes.join(', ')}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    )
  }
  // Prose mode: prefer the year-by-year checklist when the calendar page has
  // parseable requirement tables (Data Science and most Science / LFS /
  // Forestry specializations); otherwise fall back to the flat referenced-
  // courses list. parseProgramYears is pure + cheap, so calling it on render
  // is fine (no hook needed — keeps RequirementsPanel hook-free).
  const parsedYears = parseProgramYears(req.text)
  if (hasYearRequirements(parsedYears)) {
    return (
      <YearRequirements
        programUrl={req.program_url}
        parsed={parsedYears}
        plannedCodes={plannedCodes}
      />
    )
  }
  // Fallback: checklist of referenced courses + raw text.
  return <ProseRequirements req={req} courseIndex={courseIndex} plannedCodes={plannedCodes} />
}

function ProseRequirements({
  req,
  courseIndex,
  plannedCodes,
}: {
  req: Extract<ProgramRequirements, { kind: 'prose' }>
  courseIndex: Map<string, Chunk>
  plannedCodes: Set<string>
}) {
  const referenced = req.referenced_courses ?? []
  const referencedSet = new Set(referenced)
  const completedRefs = referenced.filter((c) => plannedCodes.has(c))
  // "Earned referenced credits" = sum of credit values for the referenced
  // courses currently in any term. Imprecise vs a per-category counter
  // (some courses may double-count across categories), but it gives the
  // user a useful "how much of this program's named coursework do I have
  // planned" signal until Track B's structured overlay ships.
  const earned = completedRefs.reduce(
    (sum, c) => sum + creditValue(courseIndex.get(c)),
    0,
  )
  const totalReferencedCredits = referenced.reduce(
    (sum, c) => sum + creditValue(courseIndex.get(c)),
    0,
  )
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="rounded border border-line bg-surface-soft p-2 flex flex-col gap-1">
        <div className="flex items-baseline justify-between">
          <span className="text-fg">Referenced courses</span>
          <span className="text-xs text-fg-muted">
            {completedRefs.length}/{referenced.length} planned
          </span>
        </div>
        <ProgressBar earned={earned} required={totalReferencedCredits || 1} />
        {totalReferencedCredits > 0 && (
          <p className="text-xs text-fg-faint">
            {earned}/{totalReferencedCredits} referenced credits planned
          </p>
        )}
        {referenced.length > 0 && (
          <ul className="flex flex-col gap-0.5 text-xs mt-1 max-h-40 overflow-y-auto">
            {referenced.map((code) => {
              const planned = referencedSet.has(code) && plannedCodes.has(code)
              const chunk = courseIndex.get(code)
              const title = chunk
                ? parseCourseChunk(chunk).title
                : ''
              return (
                <li
                  key={code}
                  className={`flex items-baseline gap-2 ${
                    planned ? 'text-fg' : 'text-fg-muted'
                  }`}
                >
                  {planned ? (
                    <CheckIcon className="w-3.5 h-3.5 self-center text-accent" />
                  ) : (
                    <CircleIcon className="w-3.5 h-3.5 self-center text-fg-faint" />
                  )}
                  <span className="font-mono shrink-0">{code}</span>
                  {title && (
                    <span className="truncate text-fg-faint">— {title}</span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

function ProgressBar({
  earned,
  required,
}: {
  earned: number
  required: number
}) {
  const pct = Math.max(0, Math.min(100, (earned / Math.max(required, 1)) * 100))
  return (
    <div className="h-1.5 rounded bg-line overflow-hidden">
      <div
        className="h-full bg-accent transition-[width] duration-200"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

function TotalCreditsBar({
  earned,
  required,
}: {
  earned: number
  required: number
}) {
  return (
    <div className="rounded border border-line bg-surface-soft p-2 flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-fg">Total credits</span>
        <span className="text-xs text-fg-muted">
          {earned}/{required} cr
        </span>
      </div>
      <ProgressBar earned={earned} required={required} />
    </div>
  )
}
