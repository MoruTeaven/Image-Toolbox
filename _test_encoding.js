const { execSync } = require('child_process');

const psScript = `
  $fonts = @()
  $regKeys = @(
    'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Fonts',
    'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Fonts'
  )
  foreach ($key in $regKeys) {
    if (Test-Path $key) {
      $reg = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
      if ($reg) {
        foreach ($prop in $reg.PSObject.Properties) {
          if ($prop.Name -notmatch '^PS') {
            $name = $prop.Name -replace '\\s*\\(TrueType\\)\\s*$',''
            $name = $name -replace '\\s*\\(OpenType\\)\\s*$',''
            $name = $name -replace '\\s*\\(Regular\\)\\s*$',''
            $name = $name -replace '\\s*\\(Bold\\)\\s*$',''
            $name = $name -replace '\\s*\\(Italic\\)\\s*$',''
            $name = $name -replace '\\s*\\(Bold Italic\\)\\s*$',''
            $name = $name -replace '\\s*\\(Light\\)\\s*$',''
            $name = $name -replace '\\s*\\(Medium\\)\\s*$',''
            $name = $name -replace '\\s*\\(Semibold\\)\\s*$',''
            $name = $name -replace '\\s*\\(Black\\)\\s*$',''
            $name = $name -replace '\\s*\\(Thin\\)\\s*$',''
            $name = $name -replace '\\s*\\(ExtraBold\\)\\s*$',''
            $name = $name -replace '\\s*\\(Condensed\\)\\s*$',''
            $name = $name -replace '\\s*\\(Extended\\)\\s*$',''
            $name = $name.Trim()
            if ($name) { $fonts += $name }
          }
        }
      }
    }
  }
  $fonts | Select-Object -Unique
`;

// 测试默认编码
const result1 = execSync(psScript, {
  encoding: 'utf-8',
  stdio: 'pipe',
  timeout: 10000,
  shell: 'powershell.exe',
});

const fonts1 = new Set();
for (const line of result1.split('\n')) {
  const t = line.trim();
  if (t) fonts1.add(t);
}
console.log('=== 默认编码 ===');
console.log('Count:', fonts1.size);
const cn1 = Array.from(fonts1).filter(f => /[\u4e00-\u9fff]/.test(f));
console.log('中文字体数:', cn1.length);
console.log('中文字体:', cn1);

// 测试加 chcp 65001
const psScript2 = `chcp 65001 | Out-Null;\n${psScript}`;
const result2 = execSync(psScript2, {
  encoding: 'utf-8',
  stdio: 'pipe',
  timeout: 10000,
  shell: 'powershell.exe',
});

const fonts2 = new Set();
for (const line of result2.split('\n')) {
  const t = line.trim();
  if (t && !t.startsWith('Active code page')) fonts2.add(t);
}
console.log('\n=== chcp 65001 ===');
console.log('Count:', fonts2.size);
const cn2 = Array.from(fonts2).filter(f => /[\u4e00-\u9fff]/.test(f));
console.log('中文字体数:', cn2.length);
console.log('中文字体:', cn2);

// 测试用 [Console]::OutputEncoding
const psScript3 = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n${psScript}`;
const result3 = execSync(psScript3, {
  encoding: 'utf-8',
  stdio: 'pipe',
  timeout: 10000,
  shell: 'powershell.exe',
});

const fonts3 = new Set();
for (const line of result3.split('\n')) {
  const t = line.trim();
  if (t) fonts3.add(t);
}
console.log('\n=== OutputEncoding UTF8 ===');
console.log('Count:', fonts3.size);
const cn3 = Array.from(fonts3).filter(f => /[\u4e00-\u9fff]/.test(f));
console.log('中文字体数:', cn3.length);
console.log('中文字体:', cn3);
