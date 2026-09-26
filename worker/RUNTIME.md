# Scientific compute runtime

The worker is a JSONL service over stdin/stdout. It runs persistent Jupyter Python and R kernels on the host. This is not a security sandbox; project execution consent belongs to the application.

## Portable Windows bundle

Copy these directories into Electron `extraResources`:

- `.runtime/python/cpython-3.12.13-windows-x86_64-none` to `runtime/python/cpython-3.12.13-windows-x86_64-none`.
- `.runtime/R` to `runtime/R`.
- This worker directory to `runtime/worker` (exclude `__pycache__` and generated environments).

Do not copy uv's absolute version-alias symlink, `.temp` or `.lock`. Do not put Python, R or the Python worker inside `app.asar`.

Set `SCIENCE_RUNTIME_DIR` to the installed `resources/runtime` directory. The client finds the real Python version directory and `runtime/worker/kernel_worker.py`. `SCIENCE_WORKER_DIR` can override the worker location. `ROOT_RUNTIME` is accepted as a legacy runtime-root alias. An explicit Python setting overrides interpreter selection without changing runtime discovery.

Additional writable environments live under the configured project root's `.science-environments`, or an explicit `SCIENCE_ENVIRONMENT_DIR`. The bundled default interpreter is recognized as app managed; an arbitrary shared interpreter is never eligible for package installation. `SCIENCE_R_PATH` or the client `rPath` option explicitly overrides the local R executable, while packages remain in the app-local library.

## Rebuild

`setup-python.ps1` uses uv with `--no-bin --no-registry` to install Python 3.12.13 into the app runtime and installs the version-locked scientific wheels. It does not change a shared Python or shell profile. The bundled pip fallback supports package management when uv is not present on another machine.

`setup-r.ps1` downloads and verifies the official CRAN installer, extracts it without running the Windows installer, and installs IRkernel into the private R library. No system or user-wide kernelspec is registered.

## Limits and lifecycle

Executions are serialized per kernel and can run concurrently across kernels. Output messages are matched to the Jupyter parent message ID. Each execution has a timeout; interruption is attempted first, then an unresponsive owned kernel is stopped. Some native Windows calls do not return immediately on interrupt, so restart may be required.

Outputs are limited to 500 messages or 8 MiB per execution, 4 MiB per rich display, and 128 KiB per stream chunk. Truncation is labeled. The default memory watchdog is 4 GiB per kernel process tree, sampled every second and configurable with `create.maxMemoryBytes`. It is a sampled safeguard, not an operating-system hard memory reservation. CPU and resident memory measurements are included in status events. Idle kernels close after 30 minutes by default.

Only exact owned kernel processes and their discovered descendants are terminated. Inherited environment variables with credential-like names and Python startup overrides are removed before kernel launch; host filesystem access remains possible because this is host execution.
