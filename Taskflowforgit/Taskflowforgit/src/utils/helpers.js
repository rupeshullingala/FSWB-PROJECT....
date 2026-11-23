export const STAGES = [
  { id: 'todo', label: 'To do' },
  { id: 'progress', label: 'In progress' },
  { id: 'review', label: 'In review' },
  { id: 'done', label: 'Done' },
];

export const PRIORITIES = ['Low', 'Medium', 'High'];

export const uid = () => Math.random().toString(36).slice(2, 10);

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

// Whole days from today until the deadline (negative = overdue).
export const daysUntil = (dateStr) => {
  if (!dateStr) return null;
  const diff = startOfDay(dateStr) - startOfDay(new Date());
  return Math.round(diff / 86400000);
};

// A deadline is either "YYYY-MM-DD" (whole day) or a UTC timestamp like "2026-11-05T09:30:00.000Z".
export const hasTime = (d) => Boolean(d) && d.includes('T');

export const formatDate = (dateStr) => {
  if (!dateStr) return 'No deadline';
  const date = new Date(dateStr);
  const day = date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return hasTime(dateStr)
    ? `${day}, ${date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })}`
    : day;
};

// True once the deadline has passed (for a plain date: once that day is over).
export const isPastDue = (d) => {
  if (!d) return false;
  return hasTime(d) ? Date.now() > new Date(d).getTime() : daysUntil(d) < 0;
};

const pad = (n) => String(n).padStart(2, '0');

// Value for <input type="datetime-local"> in the user's own time zone.
// An old date-only deadline is shown as end of that day (11:59 PM).
export const toInputValue = (d) => {
  if (!d) return '';
  if (!hasTime(d)) return `${d}T23:59`;
  const x = new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
};

// Convert the input's local value to the exact UTC moment the server stores.
export const fromInputValue = (v) => (v ? new Date(v).toISOString() : '');

export const timeAgo = (iso) => {
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.floor(hrs / 24)} d ago`;
};

export const stageLabel = (id) => STAGES.find((s) => s.id === id)?.label ?? id;

export const memberName = (project, id) =>
  (id && project?.members.find((m) => m.id === id)?.name) || '';
