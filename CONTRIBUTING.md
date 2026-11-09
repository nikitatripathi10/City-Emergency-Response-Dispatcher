# Contributing to City Emergency Response System (CERS)

Thank you for contributing to **CERS**! Because this platform handles safety-critical emergency dispatch workflows, all changes must pass strict security, accessibility, and type-checking gates.

## Development Workflow

1. **Fork & Clone**
   ```bash
   git clone https://github.com/nikitatripathi10/City-Emergency-Response-Dispatcher.git
   cd City-Emergency-Response-Dispatcher
   npm install
   ```
2. **Environment Configuration**
   Copy `.env.example` to `.env.local` and populate your Firebase development project credentials.
3. **Run Local Dev Server & Emulators**
   ```bash
   npm run dev
   ```
4. **Quality Gates Before Submitting a PR**
   - `npm run typecheck` — Must pass with zero TypeScript strict-mode errors.
   - `npm test` & `npm run test:rules` — All unit and Firestore/Storage security rule tests must pass.
   - Never use `innerHTML` with user-supplied data or inline `onclick` attributes; use DOM APIs (`createElement`, `textContent`, `addEventListener`).
   - Ensure WCAG 2.1 AA accessibility (form `<label>` bindings, ARIA attributes, keyboard focus states, and `.reduced-motion` support).
