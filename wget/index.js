var execFile = require('child_process').execFile;
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var archive = require('../archiver');

/**
 * Every download gets its own directory under downloads/, which keeps two
 * people downloading the same site from writing into each other's files and
 * keeps cleanup from ever reaching outside this folder.
 */
var DOWNLOAD_ROOT = path.join(__dirname, '..', 'downloads');

// wget mirrors recursively, so without a ceiling a single request can fill the
// disk. Both limits can be raised through the environment.
var QUOTA = process.env.DOWNLOAD_QUOTA || '100m';
var TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS) || 5 * 60 * 1000;

/**
 * wget --mirror --convert-links --adjust-extension --page-requisites
 * --no-parent http://example.org
 * --mirror – Makes (among other things) the download recursive.
 * --convert-links – convert all the links (also to stuff like CSS stylesheets) to relative, so it will be suitable for offline viewing.
 * --adjust-extension – Adds suitable extensions to filenames (html or css) depending on their content-type.
 * --page-requisites – Download things like CSS style-sheets and images required to properly display the page offline.
 * --no-parent – When recurring do not ascend to the parent directory. It useful for restricting the download to only a portion of the site.
 */
module.exports = (socket, data, onFinished) => {
  var done = typeof onFinished === 'function' ? onFinished : function () {};
  var send = (payload) => socket.emit(data.token, payload);

  var target = parseTarget(data.website);
  if (!target) {
    send({ error: 'That does not look like a website address. Try something like https://example.com' });
    done();
    return null;
  }

  var jobId = crypto.randomBytes(8).toString('hex');
  var jobDir = path.join(DOWNLOAD_ROOT, jobId);
  try {
    fs.mkdirSync(jobDir, { recursive: true });
  } catch (err) {
    send({ error: 'Could not create a working directory on the server: ' + err.message });
    done();
    return null;
  }

  // execFile rather than exec: the address is passed as a separate argument and
  // never reaches a shell, so it cannot be used to run other commands.
  var child = execFile('wget', [
    '-mkEpnp',
    '--no-if-modified-since',
    '--quota=' + QUOTA,
    target.href
  ], { cwd: jobDir, maxBuffer: 32 * 1024 * 1024 });

  var settled = false;
  var cancelled = false;
  var timedOut = false;
  var stderrTail = [];

  var timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, TIMEOUT_MS);

  var fail = (message) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    removeJobDir(jobDir);
    send({ error: message });
    done();
  };

  // Fires when wget itself cannot be started, which on a fresh machine almost
  // always means it is not installed.
  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      fail('wget is not installed on the server. Install it and restart the app: ' +
           'apt install wget, brew install wget, or winget install JernejSimoncic.Wget');
      return;
    }
    fail('Could not start the download: ' + err.message);
  });

  child.stderr.on('data', (chunk) => {
    var text = chunk.toString();
    stderrTail = stderrTail.concat(text.split('\n')).slice(-60);
    send({ progress: text });
  });

  child.on('close', (code) => {
    if (settled) return;
    clearTimeout(timer);

    if (cancelled) {
      settled = true;
      removeJobDir(jobDir);
      done();
      return;
    }
    if (timedOut) {
      fail('The download took longer than ' + Math.round(TIMEOUT_MS / 1000) +
           ' seconds and was stopped. Try a smaller site or a specific page.');
      return;
    }

    // Trust the filesystem rather than wget's output. wget writes nothing at
    // all for an off-site redirect, a robots.txt exclusion or a 403, and the
    // previous approach of naming the folder from the first "Resolving" line
    // then archived a directory that was never created.
    if (countFiles(jobDir) === 0) {
      fail('Nothing could be downloaded from ' + target.hostname + '. ' +
           explainFailure(stderrTail, code));
      return;
    }

    settled = true;
    send({ progress: 'Converting' });

    var zipName = target.hostname.replace(/[^a-zA-Z0-9._-]/g, '_') + '-' + jobId;
    archive(jobDir, zipName, (err, name) => {
      removeJobDir(jobDir);
      if (err) {
        send({ error: 'The site downloaded but could not be compressed: ' + err.message });
      } else {
        send({ progress: 'Completed', file: name });
      }
      done();
    });
  });

  return {
    cancel: function () {
      cancelled = true;
      child.kill();
    }
  };
};

/**
 * Accepts what the user typed and returns a URL only if it is a real http(s)
 * address. Anything else is rejected before it reaches wget.
 */
function parseTarget(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  var raw = input.trim();
  var url;
  try {
    // Only assume http:// when no scheme was given at all. Prefixing a value
    // that already has one turns file:///etc/passwd into a request for a host
    // called "file" instead of rejecting it.
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'http://' + raw);
  } catch (err) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url;
}

/**
 * wget's closing lines are usually a summary, so the last line is rarely the
 * reason anything failed. Prefer the last line that actually looks like one.
 */
function explainFailure(lines, exitCode) {
  var interesting = /failed|unable|refused|denied|ERROR \d|error \d|robots|No such|not found|forbidden|timed out|giving up|Unsupported scheme/i;
  for (var i = lines.length - 1; i >= 0; i--) {
    var line = lines[i].trim();
    if (line && interesting.test(line)) return line;
  }
  if (exitCode === 8) return 'The server refused the request (it may block automated downloads).';
  return 'wget exited with code ' + exitCode + ' without saving any files.';
}

function countFiles(directory) {
  var total = 0;
  var entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (err) {
    return 0;
  }
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].isDirectory()) {
      total += countFiles(path.join(directory, entries[i].name));
    } else {
      total++;
    }
  }
  return total;
}

/**
 * Deletes a single job directory. The guard matters: the previous version
 * joined an empty string onto the app root and recursively deleted the whole
 * application whenever the hostname had not been captured yet.
 */
function removeJobDir(directory) {
  var resolved = path.resolve(directory);
  var root = path.resolve(DOWNLOAD_ROOT);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    console.error('Refusing to delete a path outside the downloads folder: ' + resolved);
    return;
  }
  fs.rm(resolved, { recursive: true, force: true }, (err) => {
    if (err) console.error('Could not clean up ' + resolved + ': ' + err.message);
  });
}
