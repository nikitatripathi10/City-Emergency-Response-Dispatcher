export function showToast(
  message: string,
  type: "info" | "success" | "warning" | "error" = "info"
): void {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;

  const msgSpan = document.createElement("span");
  msgSpan.textContent = message;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "toast-close";
  closeBtn.setAttribute("aria-label", "Dismiss notification");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => toast.remove());

  toast.append(msgSpan, closeBtn);
  container.appendChild(toast);

  setTimeout(() => {
    if (toast.isConnected) toast.remove();
  }, 4500);
}

export function showConfirmModal(title: string, description: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const dialog = document.getElementById("confirmDialog") as HTMLDialogElement | null;
    const titleEl = document.getElementById("confirmDialogTitle");
    const descEl = document.getElementById("confirmDialogDesc");
    const okBtn = document.getElementById("confirmOkBtn");
    const cancelBtn = document.getElementById("confirmCancelBtn");

    if (!dialog || !titleEl || !descEl || !okBtn || !cancelBtn || typeof dialog.showModal !== "function") {
      resolvePromise(false);
      return;
    }

    titleEl.textContent = title;
    descEl.textContent = description;

    const cleanup = (result: boolean) => {
      okBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
      resolvePromise(result);
    };

    const onConfirm = () => cleanup(true);
    const onCancel = () => cleanup(false);

    okBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancel);

    dialog.showModal();
    cancelBtn.focus();
  });
}

export async function requestBrowserNotificationPermission(): Promise<boolean> {
  if (typeof window === "undefined" || !("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

export function sendLocalBrowserNotification(title: string, body: string): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission === "granted") {
    try {
      new Notification(title, { body });
    } catch {
      // Ignore environments where Notification constructor is restricted
    }
  }
}
