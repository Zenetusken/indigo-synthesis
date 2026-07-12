'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import {
  type DisplayUnits,
  loadUnitLabel,
  maximumDisplayLoadValue,
} from '@/modules/athletes/domain/units'
import { type SetupActionState, saveSetupAction } from './actions'
import styles from './setup.module.css'

const initialSetupActionState: SetupActionState = { errors: [] }

const days = [
  ['1', 'Monday'],
  ['2', 'Tuesday'],
  ['3', 'Wednesday'],
  ['4', 'Thursday'],
  ['5', 'Friday'],
  ['6', 'Saturday'],
  ['0', 'Sunday'],
] as const

const equipment = [
  ['barbell', 'Barbell'],
  ['rack', 'Rack with safeties'],
  ['bench', 'Bench'],
  ['plates', 'Loadable plates'],
] as const

const exercises = [
  ['development.back-squat', 'Back squat'],
  ['development.bench-press', 'Bench press'],
  ['development.barbell-row', 'Barbell row'],
  ['development.deadlift', 'Deadlift'],
  ['development.overhead-press', 'Overhead press'],
] as const

export function SetupForm() {
  const [state, action, pending] = useActionState(
    saveSetupAction,
    initialSetupActionState,
  )
  const [timezone, setTimezone] = useState('UTC')
  const [units, setUnits] = useState<DisplayUnits>('metric')
  const errorSummaryRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  }, [])

  useEffect(() => {
    if (state.errors.length > 0) errorSummaryRef.current?.focus()
  }, [state])

  return (
    <form action={action} className={styles.form}>
      {state.errors.length > 0 ? (
        <div
          className={styles.errorSummary}
          id="setup-errors"
          ref={errorSummaryRef}
          role="alert"
          tabIndex={-1}
        >
          <strong>Review the setup information</strong>
          <ul>
            {state.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <section aria-labelledby="setup-identity">
        <p className={styles.step}>Step 1 of 5 · Display</p>
        <h2 id="setup-identity">Units and training timezone</h2>
        <div className={styles.fieldGrid}>
          <label>
            <span>Display units</span>
            <select
              name="units"
              value={units}
              onChange={(event) => setUnits(event.target.value as DisplayUnits)}
            >
              <option value="metric">Metric (kg)</option>
              <option value="imperial">Imperial (lb)</option>
            </select>
            <small aria-hidden="true">&nbsp;</small>
          </label>
          <label>
            <span>IANA timezone</span>
            <input
              name="timezone"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              autoComplete="off"
              required
            />
            <small>Suggested from this browser. Confirm before continuing.</small>
          </label>
        </div>
      </section>

      <section aria-labelledby="setup-experience">
        <p className={styles.step}>Step 2 of 5 · Eligibility</p>
        <h2 id="setup-experience">Goal and experience</h2>
        <p>
          This technical MVP supports one goal: general strength development for adults
          already familiar with basic resistance-training technique.
        </p>
        <label>
          <span>Experience</span>
          <select name="experience" defaultValue="familiar">
            <option value="familiar">Familiar with the listed lifts</option>
            <option value="experienced">
              Experienced with structured barbell training
            </option>
          </select>
        </label>
        <div className={styles.checkStack}>
          <label>
            <input name="adultAttested" type="checkbox" required />
            <span>I confirm that I am at least 18 years old.</span>
          </label>
          <label>
            <input name="techniqueAttested" type="checkbox" required />
            <span>
              I confirm that I already know how to perform the listed exercises safely.
            </span>
          </label>
        </div>
      </section>

      <section aria-labelledby="setup-schedule">
        <p className={styles.step}>Step 3 of 5 · Constraints</p>
        <h2 id="setup-schedule">Equipment and schedule</h2>
        <fieldset>
          <legend>Choose exactly three training days</legend>
          <div className={styles.choiceGrid}>
            {days.map(([value, label]) => (
              <label key={value}>
                <input
                  name="weekdays"
                  type="checkbox"
                  value={value}
                  defaultChecked={['1', '3', '5'].includes(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Available equipment</legend>
          <div className={styles.choiceGrid}>
            {equipment.map(([value, label]) => (
              <label key={value}>
                <input name="equipment" type="checkbox" value={value} defaultChecked />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className={styles.shortField}>
          <span>Available minutes per session</span>
          <input
            name="sessionMinutes"
            type="number"
            inputMode="numeric"
            min={30}
            max={120}
            step={5}
            defaultValue={60}
            required
          />
        </label>
      </section>

      <section aria-labelledby="setup-loads">
        <p className={styles.step}>Step 4 of 5 · Starting values</p>
        <h2 id="setup-loads">Choose conservative starting loads</h2>
        <p>
          These are trainee-attested starting values, not measured strength or an
          automatic training-max calculation. Enter kg or lb according to the units above.
        </p>
        <div className={styles.loadGrid}>
          {exercises.map(([code, label]) => (
            <label key={code}>
              <span>
                {label} ({loadUnitLabel(units)})
              </span>
              <input
                name={`load-${code}`}
                type="number"
                inputMode="decimal"
                min={0}
                max={maximumDisplayLoadValue(units)}
                step="any"
                defaultValue={20}
                required
              />
            </label>
          ))}
        </div>
      </section>

      <section aria-labelledby="setup-safety">
        <p className={styles.step}>Step 5 of 5 · Safety and review</p>
        <h2 id="setup-safety">Current restrictions or uncertainty</h2>
        <fieldset>
          <legend>
            Do you currently have pain, a professional restriction, or uncertainty about
            participating in this training?
          </legend>
          <div className={styles.radioStack}>
            <label>
              <input name="restrictionStatus" type="radio" value="none" defaultChecked />
              <span>No current restriction or uncertainty</span>
            </label>
            <label>
              <input name="restrictionStatus" type="radio" value="present" />
              <span>Yes, I have a current restriction</span>
            </label>
            <label>
              <input name="restrictionStatus" type="radio" value="uncertain" />
              <span>I am uncertain</span>
            </label>
          </div>
        </fieldset>
        <label>
          <span>Trainee-reported context (required for “yes” or “uncertain”)</span>
          <textarea name="limitations" rows={4} maxLength={2_000} />
          <small>
            This application does not diagnose, clear participation, or replace a
            qualified professional.
          </small>
        </label>
      </section>

      <div className={styles.actionBar}>
        <div>
          <strong>Confirm these exact inputs</strong>
          <span>Changes that affect a program create a future revision.</span>
        </div>
        <button type="submit" disabled={pending}>
          {pending ? 'Saving setup…' : 'Save setup and review program'}
        </button>
      </div>
    </form>
  )
}
