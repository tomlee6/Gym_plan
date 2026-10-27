import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// The whole suite runs files in parallel and the lazily imported editor and
// viewer are heavy to transform, so a page can take over a second to appear
// on a loaded machine. Give findBy*/waitFor room before calling it a failure.
configure({ asyncUtilTimeout: 4000 });
