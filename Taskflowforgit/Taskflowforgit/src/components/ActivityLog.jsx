import { useSelector } from 'react-redux';
import { timeAgo } from '../utils/helpers.js';

export default function ActivityLog({ projectId }) {
  const activity = useSelector((s) => s.tasks.activity);
  const items = activity.filter((a) => a.projectId === projectId).slice(0, 30);

  return (
    <aside className="rounded-lg bg-white p-4 shadow-sm">
      <h2 className="font-display text-base font-bold">Activity history</h2>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-steel">Changes to this project will appear here.</p>
      ) : (
        <ol className="mt-3 space-y-3 border-l-2 border-teal-soft pl-3">
          {items.map((a) => (
            <li key={a.id} className="text-sm">
              <p>{a.text}</p>
              <p className="text-xs text-steel">{a.by ? `${a.by} \u00b7 ` : ''}{timeAgo(a.at)}</p>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
