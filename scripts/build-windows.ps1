# SPDX-License-Identifier: MIT
$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
$build=Join-Path $project 'build'
New-Item -ItemType Directory -Force $build | Out-Null
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/out:$build\edgebridge-native-win.exe" "$project\native\windows\NativeDrag.cs"
if($LASTEXITCODE -ne 0){throw 'Native build failed'}
