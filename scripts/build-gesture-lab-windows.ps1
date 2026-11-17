# SPDX-License-Identifier: MIT
param([switch]$Test)
$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
$build=Join-Path $project 'build'
New-Item -ItemType Directory -Force $build | Out-Null
$exe=Join-Path $build 'edgebridge-gesture-lab-win.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/out:$exe" "$project\native\windows\GestureLab.cs"
if($LASTEXITCODE -ne 0){throw 'Gesture lab build failed'}
if($Test){
    & $exe --self-test
    if($LASTEXITCODE -ne 0){throw 'Protocol self-test failed'}
    foreach($mode in @('cancel','release','eof','lease')){
        & $exe --private-ole-test $mode
        if($LASTEXITCODE -ne 0){throw "Private-desktop stationary OLE test failed: $mode"}
    }
}
Write-Output $exe
