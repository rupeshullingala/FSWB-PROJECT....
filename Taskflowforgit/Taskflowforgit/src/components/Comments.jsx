import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useDispatch, useSelector } from 'react-redux';
import { receiveState } from '../store/tasksSlice.js';
import { timeAgo } from '../utils/helpers.js';

export default function Comments({ taskId }) {
  const dispatch = useDispatch();
  const user = useSelector((s) => s.auth.user);
  const [comments, setComments] = useState([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    api(`/tasks/${taskId}/comments`)
      .then((d) => live && setComments(d.comments))
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [taskId]);

  const apply = ({ comments: list, ...state }) => {
    setComments(list);
    dispatch(receiveState(state));
  };

  const post = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setError('');
    try {
      apply(await api(`/tasks/${taskId}/comments`, { method: 'POST', body: { body: text } }));
      setText('');
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (id) => {
    setError('');
    try {
      apply(await api(`/comments/${id}`, { method: 'DELETE' }));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section aria-label="Comments">
      <h3 className="text-sm font-medium">Comments</h3>
      {loading ? (
        <p className="mt-1 text-xs text-steel">Loading...</p>
      ) : comments.length === 0 ? (
        <p className="mt-1 text-xs text-steel">No comments yet.</p>
      ) : (
        <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto">
          {comments.map((c) => (
            <li key={c.id} className="rounded bg-slate-50 px-3 py-2 text-sm">
              <p className="flex items-center justify-between text-xs text-steel">
                <span><span className="font-medium text-ink">{c.author}</span> &middot; {timeAgo(c.at)}</span>
                {c.userId === user.id && (
                  <button type="button" className="text-alert" onClick={() => remove(c.id)}>Delete</button>
                )}
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-1 text-xs text-alert">{error}</p>}
      <div className="mt-2 flex gap-2">
        <input
          className="field" placeholder="Write a comment" value={text} maxLength={2000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') post(e); }}
        />
        <button type="button" className="btn-ghost" onClick={post}>Post</button>
      </div>
    </section>
  );
}
