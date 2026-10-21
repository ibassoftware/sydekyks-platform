import { api } from '@/lib/api';

export type TodoStatusOption = {
  name: string;
  description: string;
  variant: string;
  continueFlow: boolean;
};

export type TodoView = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  statusOptions: TodoStatusOption[];
  status: TodoStatusOption | null;
  resolved: boolean;
  message: string | null;
  canResolve: boolean;
  assigneeId: string | null;
  created: string;
  updated: string;
};

export const todoApi = {
  get: (id: string) =>
    api.sessionScoped<TodoView>(`/v1/todos/${encodeURIComponent(id)}`, {
      method: 'GET',
    }),
  resolve: (id: string, body: { status: string; message?: string }) =>
    api.sessionScoped<TodoView>(`/v1/todos/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      data: body,
    }),
};
