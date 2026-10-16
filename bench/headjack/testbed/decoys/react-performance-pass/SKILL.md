---
name: react-performance-pass
description: "Finds and fixes unnecessary re-renders and slow interactions in React apps. Use when a React screen feels slow or profiling shows wasted renders."
---

# react-performance-pass

1. Profile with the React DevTools profiler first.
2. Memoize only components that re-render with equal props.
3. Move state down to the component that uses it.
