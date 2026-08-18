/**
 * Notification Toast System for EverydayFuel
 */

export function showToast(message: string, durationMs: number = 3000) {
  const wrapper = document.getElementById('toast-wrapper');
  if (!wrapper) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerText = message;

  wrapper.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, durationMs);
}
