"use client";

import { useEffect, useRef } from "react";

type NavigationConfirmModalProps = {
  kind: "leave" | "end" | "arrival";
  workoutDistanceKm: number;
  onCancel: () => void;
  onConfirm: () => void;
};

const copy = {
  leave: {
    eyebrow: "RUN IN PROGRESS",
    title: "러닝 화면에서 나가시겠습니까?",
    description: "현재 기록은 저장되며 나중에 이어서 달릴 수 있습니다.",
    cancel: "계속 달리기",
    confirm: "나가기",
    danger: true,
  },
  end: {
    eyebrow: "END RUN",
    title: "러닝을 종료하시겠습니까?",
    description: "종료하면 현재 기록을 러닝 기록으로 저장합니다.",
    cancel: "계속 달리기",
    confirm: "러닝 종료",
    danger: true,
  },
  arrival: {
    eyebrow: "ARRIVAL",
    title: "목적지에 도착했습니다",
    description: "현재 기록을 저장하고 러닝을 마무리할 수 있습니다.",
    cancel: "계속 진행",
    confirm: "러닝 종료",
    danger: false,
  },
} as const;

export function NavigationConfirmModal({ kind, workoutDistanceKm, onCancel, onConfirm }: NavigationConfirmModalProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const content = copy[kind];

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="navigation-confirm-backdrop" role="presentation">
      <section className="navigation-confirm-card" role="dialog" aria-modal="true" aria-labelledby="navigation-confirm-title" aria-describedby="navigation-confirm-description">
        <small>{content.eyebrow}</small>
        <strong id="navigation-confirm-title">{content.title}</strong>
        <span id="navigation-confirm-description">{content.description}</span>
        <span>기록 거리 {workoutDistanceKm.toFixed(2)} KM</span>
        <div>
          <button ref={cancelRef} type="button" onClick={onCancel}>{content.cancel}</button>
          <button type="button" className={content.danger ? "is-danger" : ""} onClick={onConfirm}>{content.confirm}</button>
        </div>
      </section>
    </div>
  );
}
