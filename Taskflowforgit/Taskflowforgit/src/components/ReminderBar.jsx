import { useSelector } from 'react-redux';
import { daysUntil, isPastDue, memberName } from '../utils/helpers.js';

export default function ReminderBar({ projectId }) {
  const { projects, tasks } = useSelector((s) => s.tasks);
  const project = projects.find((p) => p.id === projectId);

  const due = tasks
    .filter((t) => t.projectId === projectId && t.reminder && t.status !== 'done' && t.deadline)
    .map((t) => ({ ...t, days: daysUntil(t.deadline), late: isPastDue(t.deadline) }))
    .filter((t) => t.days <= 2)
    .sort((a, b) => a.days - b.days);

  if (!due.length) return null;

  return (
    <div role="status" className="mb-4 rounded-md border border-signal/40 bg-amber-50 px-4 py-3 text-sm">
      <p className="font-medium">Reminders</p>
      <ul className="mt-1 space-y-0.5">
        {due.map((t) => (
          <li key={t.id}>
            <span className="font-medium">{t.title}</span>{' '}
            {t.late ? (
              <span className="text-alert">
                is overdue{t.days < 0 ? ` by ${Math.abs(t.days)} day(s)` : ''}
              </span>
            ) : t.days === 0 ? (
              <span className="text-alert">is due today</span>
            ) : (
              <span>is due in {t.days} day(s)</span>
            )}
            {t.assignee && <span className="text-steel"> ({memberName(project, t.assignee)})</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
