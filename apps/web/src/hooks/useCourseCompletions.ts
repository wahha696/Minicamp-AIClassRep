import { useEffect, useRef, useState } from 'react';
import { getCourseCompletions, setCourseCompletion } from '../api/course-completions';
import type { Occurrence } from '../../../../shared/timetable';
import type { CourseCompletionControl } from '../components/WeekGrid';
import { usePolling } from './usePolling';

export function useCourseCompletions(epoch: string, from: string, to: string, revision: number | undefined, readonly: boolean) {
  const [confirmed, setConfirmed] = useState<Record<string, { epoch: string; revision: number; start: number; end: number; done: boolean }>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const pending = useRef(new Set<string>());
  const mutation = useRef(0);
  const alive = useRef(true);
  const scope = useRef(epoch); scope.current = epoch;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setConfirmed({}); setBusy({}); setErrors({}); pending.current.clear(); mutation.current++; }, [epoch]);
  const state = usePolling(async () => {
    const generation = mutation.current;
    const result = await getCourseCompletions(epoch, from, to);
    if (alive.current && scope.current === epoch && mutation.current === generation) setConfirmed({});
    return { ...result, epoch, from, to };
  }, 30_000, `${epoch}:${from}:${to}:${revision ?? ''}`);
  function forOccurrence(occurrence: Occurrence): CourseCompletionControl {
    const current = state.data?.epoch === epoch && state.data.from === from && state.data.to === to && state.data.revision === revision;
    const receipt = confirmed[occurrence.id];
    const done = receipt?.epoch === epoch && receipt.revision === revision && receipt.start === occurrence.start && receipt.end === occurrence.end ? receipt.done
      : current && state.data?.completions.some(item => item.done && item.occurrence_id === occurrence.id && item.start === occurrence.start && item.end === occurrence.end) || false;
    return { done, busy: busy[occurrence.id], disabled: !epoch || !current || !!state.error || revision === undefined,
      error: errors[occurrence.id], onToggle: readonly ? undefined : () => {
        const requestKey = `${epoch}:${occurrence.id}`;
        if (!epoch || revision === undefined || !current || state.error || pending.current.has(requestKey)) return;
        pending.current.add(requestKey); mutation.current++;
        setBusy(prev => ({ ...prev, [occurrence.id]: true })); setErrors(prev => ({ ...prev, [occurrence.id]: '' }));
        void setCourseCompletion(epoch, { occurrence_id: occurrence.id, date: occurrence.date, expected_start: occurrence.start, expected_end: occurrence.end, expected_revision: revision, done: !done })
          .then(async result => {
            if (!alive.current || scope.current !== epoch) return;
            // An older poll cannot replace the acknowledged result while a follow-up read is pending.
            mutation.current++;
            setConfirmed(prev => ({ ...prev, [occurrence.id]: { epoch, revision, start: result.completion.start, end: result.completion.end, done: result.completion.done } }));
            await state.refresh();
          }).catch(error => {
            if (alive.current && scope.current === epoch) setErrors(prev => ({ ...prev, [occurrence.id]: error instanceof Error ? error.message : '保存失败，请重试' }));
          }).finally(() => {
            if (alive.current && scope.current === epoch) {
              pending.current.delete(requestKey);
              setBusy(prev => ({ ...prev, [occurrence.id]: false }));
            }
          });
      } };
  }
  return { state, forOccurrence };
}
