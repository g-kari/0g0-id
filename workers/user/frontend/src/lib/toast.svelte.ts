type ToastType = "success" | "error";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

const state = $state<{ toasts: Toast[] }>({ toasts: [] });
let nextId = 0;

export function showToast(message: string, type: ToastType = "success") {
  const id = nextId++;
  state.toasts.push({ id, message, type });
  setTimeout(() => {
    const idx = state.toasts.findIndex((t) => t.id === id);
    if (idx !== -1) state.toasts.splice(idx, 1);
  }, 3000);
}

export function getToasts(): Toast[] {
  return state.toasts;
}
