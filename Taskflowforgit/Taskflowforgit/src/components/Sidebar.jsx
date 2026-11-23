import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { logout } from '../store/authSlice.js';
import { act, selectProject } from '../store/tasksSlice.js';

export default function Sidebar() {
  const dispatch = useDispatch();
  const user = useSelector((s) => s.auth.user);
  const { projects, activeProjectId } = useSelector((s) => s.tasks);
  const [name, setName] = useState('');
  const [members, setMembers] = useState('');

  const addProject = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    const list = members.split(',').map((m) => m.trim()).filter(Boolean);
    if (await dispatch(act({ type: 'ADD_PROJECT', name: name.trim(), members: list }))) {
      setName('');
      setMembers('');
    }
  };

  return (
    <nav className="bg-ink p-4 text-white md:min-h-screen md:w-64" aria-label="Projects">
      <h1 className="font-display text-xl font-bold">TaskFlow</h1>
      <p className="mt-1 text-xs text-slate-300">
        Signed in as <span className="font-medium text-white">{user.name}</span>
      </p>
      <button className="mt-1 text-xs text-slate-300 underline" onClick={() => dispatch(logout())}>Log out</button>
      <p className="mt-4 text-xs text-slate-300">Projects</p>

      <ul className="mt-3 space-y-1">
        {projects.map((p) => (
          <li key={p.id}>
            <button
              onClick={() => dispatch(selectProject(p.id))}
              className={`w-full rounded px-3 py-2 text-left text-sm ${
                p.id === activeProjectId ? 'bg-teal' : 'hover:bg-white/10'
              }`}
            >
              {p.name}
            </button>
          </li>
        ))}
      </ul>

      <form onSubmit={addProject} className="mt-6 space-y-2">
        <p className="text-sm font-medium">New project</p>
        <input className="field !text-ink" placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="field !text-ink" placeholder="Member emails, comma separated" value={members} onChange={(e) => setMembers(e.target.value)} />
        <button className="btn-primary w-full" type="submit">Create project</button>
      </form>
    </nav>
  );
}
