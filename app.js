require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { Octokit } = require('@octokit/rest');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ============ CONFIG ============
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const AIPIPE_TOKEN = process.env.AIPIPE_TOKEN;
const SHARED_SECRET = process.env.SHARED_SECRET || 'your-secret-from-google-form';
const GITHUB_USERNAME = '23f3002017'; // Your GitHub username
const TEMP_DIR = path.join(__dirname, 'temp-repos');
const PORT = process.env.PORT || 3000;

const octokit = new Octokit({ auth: GITHUB_TOKEN });

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ============ MAIN ENDPOINT ============
app.post('/api/generate', async (req, res) => {
  try {
    console.log('📥 Received request:', req.body);

    if (req.body.secret !== SHARED_SECRET) {
      console.error('❌ Invalid secret');
      return res.status(401).json({ error: 'Invalid secret' });
    }

    res.status(200).json({ 
      status: 'Processing',
      message: 'Request received. Generating and deploying app...'
    });

    processRequest(req.body).catch(err => {
      console.error('❌ Error processing request:', err);
    });

  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ STEP 4: PARSE & GENERATE APP WITH AIPIPE ============
async function generateApp(brief, attachments, checks) {
  console.log('🤖 Generating app with AIpipe + OpenRouter...');

  const downloadedAttachments = {};
  for (const att of attachments) {
    const base64Data = att.url.split(',')[1];
    const buffer = Buffer.from(base64Data, 'base64');
    downloadedAttachments[att.name] = buffer.toString('utf-8');
  }

  const attachmentContext = Object.entries(downloadedAttachments)
    .map(([name, content]) => `**File: ${name}**\n\`\`\`\n${content.substring(0, 500)}\n\`\`\``)
    .join('\n\n');

  const checksStr = checks.map(c => `- ${c}`).join('\n');

  const prompt = `You are an expert web developer. Create a minimal, production-ready single-page HTML application.

**Brief:**
${brief}

**Attached Files:**
${attachmentContext}

**Checks (must pass all):**
${checksStr}

**Requirements:**
1. Return ONLY valid HTML (single file, no external builds)
2. Include all necessary JS/CSS inline or via CDN
3. Use semantic HTML and ARIA labels
4. Include comments explaining key logic
5. Handle errors gracefully
6. Make it responsive and accessible

**CRITICAL: Return ONLY the HTML code block wrapped in triple backticks, nothing else.**`;

  try {
    const response = await axios.post(
      'https://aipipe.org/openrouter/v1/chat/completions',
      {
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4000,
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${AIPIPE_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    let html = response.data.choices[0].message.content;

    if (html.includes('```html')) {
      html = html.split('```html')[1].split('```')[0].trim();
    } else if (html.includes('```')) {
      html = html.split('```')[1].split('```')[0].trim();
    }

    console.log('✅ App generated successfully');
    return html;

  } catch (error) {
    console.error('❌ AIpipe API error:', error.response?.data || error.message);
    throw new Error(`Failed to generate app: ${error.message}`);
  }
}

// ============ STEP 5-6: CREATE REPO & PUSH ============
async function createAndPushRepo(email, task, html, brief, checks) {
  console.log('📦 Creating GitHub repo...');

  const repoName = task.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  try {
    const repo = await octokit.repos.createForAuthenticatedUser({
      name: repoName,
      description: `Auto-generated: ${brief.substring(0, 60)}...`,
      private: false,
      auto_init: true
    });

    console.log(`✅ Repo created: ${repo.data.html_url}`);

    const repoPath = path.join(TEMP_DIR, repoName);
    if (fs.existsSync(repoPath)) {
      execSync(`rm -rf ${repoPath}`);
    }

    // Clone with token in URL for Render compatibility
    const gitCloneUrl = `https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@github.com/${GITHUB_USERNAME}/${repoName}.git`;
    execSync(`git clone ${gitCloneUrl} ${repoPath}`, {
      env: { 
        ...process.env, 
        GIT_AUTHOR_NAME: email, 
        GIT_AUTHOR_EMAIL: email,
        GIT_TERMINAL_PROMPT: '0'
      }
    });

    // Add MIT License
    const licenseText = `MIT License

Copyright (c) 2025 ${email}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.`;

    // Write LICENSE
    const licensePath = path.join(repoPath, 'LICENSE');
    fs.writeFileSync(licensePath, licenseText);
    console.log('✅ LICENSE file created');

    // Write index.html
    const htmlPath = path.join(repoPath, 'index.html');
    fs.writeFileSync(htmlPath, html);
    console.log('✅ index.html file created');

    // Verify files were written
    if (!fs.existsSync(licensePath)) throw new Error('LICENSE file not written');
    if (!fs.existsSync(htmlPath)) throw new Error('index.html file not written');

    const readme = `# ${task}

## Overview
${brief}

## Requirements Checklist
${checks.map(c => `- [ ] ${c}`).join('\n')}

## Setup
1. Clone this repository:
   \`\`\`bash
   git clone ${repo.data.clone_url}
   cd ${repoName}
   \`\`\`

2. Open \`index.html\` in your web browser

## Usage
Live demo: https://${repo.data.owner.login}.github.io/${repoName}/

Open the page and interact with the application. All functionality is contained in the single HTML file.

## File Structure
- \`index.html\` - Complete application with inline CSS and JavaScript
- \`LICENSE\` - MIT License
- \`README.md\` - This file

## Code Explanation
This is a single-file HTML application auto-generated using OpenRouter LLMs via AIpipe.

**Key Features:**
- Fully self-contained (no build step needed)
- Responsive design
- Accessible markup (ARIA labels)
- Error handling
- Browser-compatible (no external dependencies beyond CDN resources)

## Technology Stack
- HTML5
- CSS3
- Vanilla JavaScript (ES6+)
- CDN resources (Bootstrap, etc. as needed)

## Browser Compatibility
Works in all modern browsers (Chrome, Firefox, Safari, Edge)

## License
MIT License - See LICENSE file for full details

---
*Generated automatically*`;

    fs.writeFileSync(path.join(repoPath, 'README.md'), readme);
    console.log('✅ README.md file created');

    fs.writeFileSync(path.join(repoPath, '.gitignore'), `node_modules/
.env
.env.local
.DS_Store
.vscode/
.idea/
*.log
temp/`);
    console.log('✅ .gitignore file created');

    const packageJson = {
      name: repoName,
      version: '1.0.0',
      description: brief,
      main: 'index.html',
      scripts: { start: 'python -m http.server 8000' },
      author: email,
      license: 'MIT'
    };
    fs.writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify(packageJson, null, 2));
    console.log('✅ package.json file created');

    // Configure git locally for this repo
    execSync('git config user.name "' + email + '"', { cwd: repoPath });
    execSync('git config user.email "' + email + '"', { cwd: repoPath });

    // Verify files exist before commit
    const files = fs.readdirSync(repoPath);
    console.log('📂 Files in repo:', files);

    // Commit
    execSync('git add .', { cwd: repoPath });
    execSync(`git commit -m "Initial commit: Auto-generated app for ${task}"`, { 
      cwd: repoPath,
      env: { 
        ...process.env, 
        GIT_AUTHOR_NAME: email, 
        GIT_AUTHOR_EMAIL: email, 
        GIT_COMMITTER_NAME: email, 
        GIT_COMMITTER_EMAIL: email,
        GIT_TERMINAL_PROMPT: '0'
      }
    });

    // Push with token in URL for Render compatibility
    const gitPushUrl = `https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@github.com/${GITHUB_USERNAME}/${repoName}.git`;
    execSync(`git -c core.sshCommand="ssh -o StrictHostKeyChecking=no" push -u ${gitPushUrl} main`, { 
      cwd: repoPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });

    const commitSha = execSync('git rev-parse HEAD', { cwd: repoPath }).toString().trim();

    // Enable GitHub Pages
    try {
      await octokit.repos.update({
        owner: repo.data.owner.login,
        repo: repoName,
        has_pages: true,
        pages: {
          source: {
            branch: 'main',
            path: '/'
          }
        }
      });
    } catch (e) {
      console.warn('⚠️ Could not update Pages settings via API:', e.message);
    }

    const pagesUrl = `https://${repo.data.owner.login}.github.io/${repoName}/`;
    
    console.log(`✅ Repo ready: ${repo.data.html_url}`);
    console.log(`✅ Pages URL: ${pagesUrl}`);
    console.log(`✅ Commit SHA: ${commitSha}`);

    return {
      repo_url: repo.data.html_url,
      commit_sha: commitSha,
      pages_url: pagesUrl,
      owner: repo.data.owner.login
    };

  } catch (error) {
    console.error('❌ Repo creation error:', error.message);
    throw error;
  }
}

// ============ STEP 7-8: REPORT & RETRY ============
async function reportResults(evaluationUrl, payload, attempt = 1) {
  const maxAttempts = 10;
  const delays = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];

  try {
    console.log(`📤 Attempt ${attempt}: Posting to ${evaluationUrl}...`);
    const response = await axios.post(evaluationUrl, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });

    if (response.status === 200) {
      console.log('✅ Successfully reported to evaluation URL');
      return true;
    }
  } catch (error) {
    console.error(`⚠️ Attempt ${attempt} failed:`, error.message);

    if (attempt < maxAttempts) {
      const delayMs = delays[attempt - 1] * 1000;
      console.log(`⏳ Retrying in ${delays[attempt - 1]}s...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return reportResults(evaluationUrl, payload, attempt + 1);
    } else {
      console.error('❌ Max retries exceeded.');
      return false;
    }
  }
}

// ============ ROUND 2: MODIFY EXISTING REPO ============
async function modifyExistingRepo(email, task, brief, checks) {
  console.log('📝 Modifying existing repo for Round 2...');

  const repoName = task.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const repoPath = path.join(TEMP_DIR, repoName);

  try {
    // Get existing repo URL
    const repos = await octokit.repos.listForAuthenticatedUser();
    const existingRepo = repos.data.find(r => r.name === repoName);
    
    if (!existingRepo) {
      throw new Error(`Repo ${repoName} not found`);
    }

    console.log(`✅ Found existing repo: ${existingRepo.html_url}`);

    // Delete old clone if exists
    if (fs.existsSync(repoPath)) {
      execSync(`rm -rf ${repoPath}`);
    }

    // Clone the existing repo
    const gitCloneUrl = `https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@github.com/${GITHUB_USERNAME}/${repoName}.git`;
    execSync(`git clone ${gitCloneUrl} ${repoPath}`, {
      env: { 
        ...process.env, 
        GIT_AUTHOR_NAME: email, 
        GIT_AUTHOR_EMAIL: email,
        GIT_TERMINAL_PROMPT: '0'
      }
    });

    console.log('✅ Cloned existing repo');

    // Read existing HTML
    const htmlPath = path.join(repoPath, 'index.html');
    const existingHtml = fs.readFileSync(htmlPath, 'utf-8');

    // Generate improved HTML based on brief
    console.log('🤖 Improving app with AI...');
    const improvedHtml = await improveApp(existingHtml, brief, checks);

    // Write updated index.html
    fs.writeFileSync(htmlPath, improvedHtml);
    console.log('✅ Updated index.html');

    // Update README.md with new requirements
    const readmePath = path.join(repoPath, 'README.md');
    const newReadme = `# ${task}

## Overview
${brief}

## Updated Requirements Checklist (Round 2)
${checks.map(c => `- [ ] ${c}`).join('\n')}

## Setup
1. Clone this repository:
   \`\`\`bash
   git clone ${existingRepo.clone_url}
   cd ${repoName}
   \`\`\`

2. Open \`index.html\` in your web browser

## Usage
Live demo: https://${existingRepo.owner.login}.github.io/${repoName}/

Open the page and interact with the application. All functionality is contained in the single HTML file.

## File Structure
- \`index.html\` - Complete application with inline CSS and JavaScript
- \`LICENSE\` - MIT License
- \`README.md\` - This file

## Code Explanation
This is a single-file HTML application auto-generated and improved using OpenRouter LLMs via AIpipe.

**Key Features:**
- Fully self-contained (no build step needed)
- Responsive design
- Accessible markup (ARIA labels)
- Error handling
- Browser-compatible (no external dependencies beyond CDN resources)

## Technology Stack
- HTML5
- CSS3
- Vanilla JavaScript (ES6+)
- CDN resources (Bootstrap, etc. as needed)

## Browser Compatibility
Works in all modern browsers (Chrome, Firefox, Safari, Edge)

## License
MIT License - See LICENSE file for full details

---
*Generated and improved automatically (Round 2)*`;

    fs.writeFileSync(readmePath, newReadme);
    console.log('✅ Updated README.md');

    // Configure git locally for this repo
    execSync('git config user.name "' + email + '"', { cwd: repoPath });
    execSync('git config user.email "' + email + '"', { cwd: repoPath });

    // Commit and push
    execSync('git add .', { cwd: repoPath });
    execSync(`git commit -m "Round 2: Improved app - ${brief.substring(0, 50)}"`, { 
      cwd: repoPath,
      env: { 
        ...process.env, 
        GIT_AUTHOR_NAME: email, 
        GIT_AUTHOR_EMAIL: email, 
        GIT_COMMITTER_NAME: email, 
        GIT_COMMITTER_EMAIL: email,
        GIT_TERMINAL_PROMPT: '0'
      }
    });

    const gitPushUrl = `https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@github.com/${GITHUB_USERNAME}/${repoName}.git`;
    execSync(`git push ${gitPushUrl} main`, { 
      cwd: repoPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });

    console.log('✅ Pushed changes to GitHub');

    const commitSha = execSync('git rev-parse HEAD', { cwd: repoPath }).toString().trim();
    const pagesUrl = `https://${existingRepo.owner.login}.github.io/${repoName}/`;

    console.log(`✅ Round 2 complete`);
    console.log(`✅ Commit SHA: ${commitSha}`);

    return {
      repo_url: existingRepo.html_url,
      commit_sha: commitSha,
      pages_url: pagesUrl,
      owner: existingRepo.owner.login
    };

  } catch (error) {
    console.error('❌ Repo modification error:', error.message);
    throw error;
  }
}

// ============ IMPROVE EXISTING APP ============
async function improveApp(existingHtml, brief, checks) {
  console.log('🤖 Sending to AI for improvement...');

  const checksStr = checks.map(c => `- ${c}`).join('\n');

  const prompt = `You are an expert web developer. Improve the existing HTML application based on the new requirements.

**Current HTML:**
\`\`\`html
${existingHtml.substring(0, 1500)}
\`\`\`

**New Requirements:**
${brief}

**New Checks (must pass all):**
${checksStr}

**Instructions:**
1. Improve the existing code, don't rewrite from scratch
2. Keep the same structure and style
3. Add only the new features requested
4. Ensure all checks pass
5. Return ONLY the complete updated HTML code wrapped in triple backticks

**CRITICAL: Return ONLY the HTML code block wrapped in triple backticks, nothing else.**`;

  try {
    const response = await axios.post(
      'https://aipipe.org/openrouter/v1/chat/completions',
      {
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4000,
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${AIPIPE_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    let html = response.data.choices[0].message.content;

    if (html.includes('```html')) {
      html = html.split('```html')[1].split('```')[0].trim();
    } else if (html.includes('```')) {
      html = html.split('```')[1].split('```')[0].trim();
    }

    console.log('✅ App improved successfully');
    return html;

  } catch (error) {
    console.error('❌ AIpipe improvement error:', error.response?.data || error.message);
    throw new Error(`Failed to improve app: ${error.message}`);
  }
}

// ============ MAIN PROCESSOR ============
async function processRequest(request) {
  try {
    const { email, task, round, nonce, brief, checks, attachments, evaluation_url } = request;

    console.log(`\n🚀 Processing task: ${task} (round ${round})`);

    let repoInfo;

    if (round === 1) {
      // Round 1: Create new app
      const html = await generateApp(brief, attachments || [], checks || []);
      repoInfo = await createAndPushRepo(email, task, html, brief, checks);
    } else if (round === 2) {
      // Round 2: Modify existing app
      repoInfo = await modifyExistingRepo(email, task, brief, checks);
    } else {
      throw new Error(`Unknown round: ${round}`);
    }

    console.log('⏳ Waiting 10 seconds for GitHub Pages to deploy...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    const payload = {
      email,
      task,
      round,
      nonce,
      repo_url: repoInfo.repo_url,
      commit_sha: repoInfo.commit_sha,
      pages_url: repoInfo.pages_url
    };

    console.log('📊 Final payload:', payload);
    await reportResults(evaluation_url, payload);

  } catch (error) {
    console.error('❌ Fatal error during processing:', error);
  }
}

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ START SERVER ============
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 LLM Deployment Server Started`);
  console.log(`${'='.repeat(50)}`);
  console.log(`📝 API Endpoint: http://localhost:${PORT}/api/generate`);
  console.log(`🏥 Health Check: http://localhost:${PORT}/health`);
  console.log(`🔑 Using AIpipe for LLM calls`);
  console.log(`${'='.repeat(50)}\n`);
});