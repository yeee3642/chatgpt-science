param([string]$RuntimeRoot = (Join-Path $PSScriptRoot '../.runtime/R'))
$ErrorActionPreference = 'Stop'
$RuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
$downloadRoot = Join-Path $RuntimeRoot 'downloads'
New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
$installer = Join-Path $downloadRoot 'R-4.6.1-win.exe'
$archive = Join-Path $downloadRoot 'innoextract-1.9-windows.zip'
# Official, version-pinned sources. The R checksum is the fingerprint published
# at https://cran.r-project.org/bin/windows/base/md5sum.R-4.6.1.txt.
if (!(Test-Path -LiteralPath $installer)) {
    Invoke-WebRequest -Uri 'https://cran.r-project.org/bin/windows/base/R-4.6.1-win.exe' -OutFile $installer
}
if ((Get-FileHash -LiteralPath $installer -Algorithm MD5).Hash -ne '7907F3A20EC8EC88CD0DA279024B8E27') {
    throw 'R installer checksum mismatch; no installer content was executed.'
}
if (!(Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -Uri 'https://github.com/dscharrer/innoextract/releases/download/1.9/innoextract-1.9-windows.zip' -OutFile $archive
}
$extractorRoot = Join-Path $downloadRoot 'innoextract'
Expand-Archive -LiteralPath $archive -DestinationPath $extractorRoot -Force
& (Join-Path $extractorRoot 'innoextract.exe') --silent --output-dir $RuntimeRoot $installer
if ($LASTEXITCODE -ne 0) { throw 'R extraction failed.' }
# This only extracts the runtime. It never runs R's Windows installer and never
# installs a system/user Jupyter kernelspec or modifies shell/registry settings.
$rscript = Join-Path $RuntimeRoot 'app/bin/Rscript.exe'
$library = Join-Path $RuntimeRoot 'library'
& $rscript --vanilla (Join-Path $PSScriptRoot 'install_r_kernel.R') $library
if ($LASTEXITCODE -ne 0) { throw 'App-local IRkernel setup failed.' }
Get-FileHash -LiteralPath $installer, $archive -Algorithm SHA256
