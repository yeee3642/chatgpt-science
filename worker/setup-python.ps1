param([string]$RuntimeRoot = (Join-Path $PSScriptRoot '../.runtime'))
$ErrorActionPreference = 'Stop'
$RuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
$pythonRoot = Join-Path $RuntimeRoot 'python'
New-Item -ItemType Directory -Path $pythonRoot -Force | Out-Null
$uv = (Get-Command uv -CommandType Application -ErrorAction Stop).Source
# No global bin links, registry entries, or shell profile changes.
& $uv python install 3.12.13 --install-dir $pythonRoot --no-bin --no-registry --no-config
if ($LASTEXITCODE -ne 0) { throw 'App-local standalone Python installation failed.' }
$python = Join-Path $pythonRoot 'cpython-3.12.13-windows-x86_64-none/python.exe'
if (!(Test-Path -LiteralPath $python)) { throw 'Expected standalone Python executable was not created.' }
$requirements = Join-Path $PSScriptRoot 'requirements-lock.txt'
if (!(Test-Path -LiteralPath $requirements)) { $requirements = Join-Path $PSScriptRoot 'requirements.txt' }
# The override applies only to this app-owned standalone prefix, never a shared
# interpreter. uv marks its standalone distributions externally managed.
& $uv pip install --python $python --break-system-packages --only-binary=:all: -r $requirements pip
if ($LASTEXITCODE -ne 0) { throw 'App-local scientific Python dependencies failed to install.' }
& $python -I -c 'import sys, numpy, pandas, matplotlib, pyarrow, jupyter_client, ipykernel; print(sys.executable); print(sys.prefix)'
if ($LASTEXITCODE -ne 0) { throw 'Standalone Python import validation failed.' }
Write-Output 'For packaging, include the real version directory, not uv version alias symlinks.'
