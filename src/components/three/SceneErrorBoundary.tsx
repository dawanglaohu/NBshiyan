'use client';
import { Component, type ReactNode } from 'react';

/** 3D 内容出错（模型 404、解码失败、WebGL 不可用）时只隐藏这一块，不让整页崩成 Application error（issue #31） */
export default class SceneErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode; onError?: (e: unknown) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) {
    console.warn('[3D] model failed, falling back to poster', e);
    this.props.onError?.(e);
  }
  render() { return this.state.failed ? (this.props.fallback ?? null) : this.props.children; }
}
