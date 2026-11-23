import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { restoreSession } from './store/authSlice.js';
import { act, clearNotice, fetchState, sendRemindersNow } from './store/tasksSlice.js';
import { fetchWeather } from './store/weatherSlice.js';
import AuthPage from './components/AuthPage.jsx';
import Sidebar from './components/Sidebar.jsx';
import Board from './components/Board.jsx';
import TaskModal from './components/TaskModal.jsx';
import ActivityLog from './components/ActivityLog.jsx';
import ReminderBar from './components/ReminderBar.jsx';
import WeatherCard from './components/WeatherCard.jsx';

export default function App() {
  const dispatch = useDispatch();
  const { user, checking } = useSelector((s) => s.auth);
  const hasResetToken = new URLSearchParams(window.location.search).has('resetToken');
  if (hasResetToken) return <AuthPage />;

  // On first load, try to get back into the session with the refresh cookie.
  useEffect(() => { dispatch(restoreSession()); }, [dispatch]);

  if (checking) return <p className="p-6 text-steel">Loading...</p>;
  if (!user) return <AuthPage />;
  return <Dashboard key={user.id} />;
}

function Dashboard() {
  const dispatch = useDispatch();
  const user = useSelector((s) => s.auth.user);
  const { projects, activeProjectId, loading, notice } = useSelector((s) => s.tasks);
  const project = projects.find((p) => p.id === activeProjectId);

  useEffect(() => {
    dispatch(fetchState());
    dispatch(fetchWeather(localStorage.getItem('taskflow-city') ?? ''));
  }, [dispatch]);

  const [modal, setModal] = useState(null); // { task } when open
  const [member, setMember] = useState('');

  const isOwner = project?.ownerId === user.id;

  const addMember = async (e) => {
    e.preventDefault();
    if (!member.trim()) return;
    if (await dispatch(act({ type: 'ADD_MEMBER', projectId: project.id, email: member.trim() }))) setMember('');
  };

  const removeProject = () => {
    if (window.confirm(`Delete "${project.name}" and all its tasks?`))
      dispatch(act({ type: 'DELETE_PROJECT', id: project.id }));
  };

  return (
    <div className="md:flex">
      <Sidebar />
      <main className="flex-1 p-4 md:p-6">
        {notice && (
          <div role="alert" className="mb-4 flex items-start justify-between gap-3 rounded-md border border-alert/40 bg-orange-50 px-4 py-2 text-sm">
            <span>{notice}</span>
            <button className="text-xs underline" onClick={() => dispatch(clearNotice())}>Dismiss</button>
          </div>
        )}
        {loading ? (
          <p className="text-steel">Loading your projects...</p>
        ) : !project ? (
          <p className="text-steel">Create your first project from the sidebar to get started.</p>
        ) : (
          <>
            <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-2xl font-bold">{project.name}</h2>
                <p className="text-sm text-steel">
                  Team: {project.members.map((m) => m.name).join(', ')}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {isOwner && (
                  <form onSubmit={addMember} className="flex gap-2">
                    <input type="email" className="field !w-52" placeholder="Add member by email" value={member} onChange={(e) => setMember(e.target.value)} />
                    <button className="btn-ghost" type="submit">Add</button>
                  </form>
                )}
                <button className="btn-primary" onClick={() => setModal({ task: null })}>New task</button>
                <button className="btn-ghost" onClick={() => dispatch(sendRemindersNow())} title="Email reminders for tasks that are due soon or overdue">Send reminders now</button>
                {isOwner && <button className="btn-ghost" onClick={removeProject}>Delete project</button>}
              </div>
            </header>

            <ReminderBar projectId={project.id} />

            <div className="grid gap-4 xl:grid-cols-[1fr_18rem]">
              <Board project={project} onEdit={(task) => setModal({ task })} />
              <div className="space-y-4">
                <WeatherCard />
                <ActivityLog projectId={project.id} />
              </div>
            </div>

            {modal && (
              <TaskModal project={project} task={modal.task} onClose={() => setModal(null)} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
