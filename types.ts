export type Priority = 'High' | 'Medium' | 'Low';
export type Status = 'active' | 'paused' | 'completed';
export type Entity = 'tasks' | 'goals' | 'projects' | 'milestones';
export const ENTITIES: Entity[] = ['goals', 'projects', 'milestones', 'tasks'];

type Base = { id: string; workspace_id: string; version: number };
export type Task = Base & { title: string; priority: Priority; due: string | null; done: boolean; project_id: string | null; milestone_id: string | null };
export type Goal = Base & { title: string; description: string; status: Status; target_date: string | null };
export type Project = Base & { title: string; goal_id: string | null; status: Status; target_date: string | null };
export type Milestone = Base & { title: string; project_id: string; due: string | null; done: boolean };
export type Workspace = { id: string; name: string; kind: string };
export type Data = { tasks: Task[]; goals: Goal[]; projects: Project[]; milestones: Milestone[] };
export const emptyData = (): Data => ({ tasks: [], goals: [], projects: [], milestones: [] });
