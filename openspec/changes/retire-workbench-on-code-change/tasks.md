## 1. Code-Change Retirement

- [x] 1.1 Resolve the watch target from the runtime entry: the dev source tree, otherwise the executable
- [x] 1.2 Retire an owned workbench through the existing owned shutdown path when that target changes

## 2. Verification

- [x] 2.1 Cover target resolution for compiled and dev entries, and that a change to the watched target retires
- [x] 2.2 Run the unit suite and the repository verification gate
