# AI Flutter App Builder

This repository contains the first working frontend for an AI-powered Flutter application builder.

## Included
- Project creation workspace
- Flutter file tree
- Editable Dart/YAML source
- AI assistant workspace
- Build-job tracking
- Honest external build-runner state
- Responsive developer UI
- GitHub Actions build/deploy workflow

## Important
The browser does not compile Flutter or manufacture APK/AAB files. Build APK/AAB buttons create tracked build jobs and explicitly report that the external Flutter runner is not configured.

To produce real artifacts, connect a secure backend/build runner that receives the project source, runs an isolated Flutter build, and returns a real artifact URL.

## Development
npm install
npm run dev

## Production
npm run build
