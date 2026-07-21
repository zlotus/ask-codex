import { AlertTriangle, Check, Info, X } from "lucide-react";
import type { ToastMessage } from "../types/protocol";

interface ToastsProps {
  toasts: ToastMessage[];
  onClose: (id: number) => void;
}

export function Toasts({ toasts, onClose }: ToastsProps) {
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = toast.tone === "error" ? AlertTriangle : toast.tone === "success" ? Check : Info;
        return (
          <div key={toast.id} className={`toast toast--${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
            <Icon size={16} aria-hidden="true" />
            <span>{toast.message}</span>
            <button className="toast-close" type="button" aria-label="Dismiss" onClick={() => onClose(toast.id)}><X size={14} /></button>
          </div>
        );
      })}
    </div>
  );
}
