const fs = require('node:fs')
const path = require('node:path')
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins')

const PROVIDER_NAME = '.NativeCrashInitProvider'

function addCrashInitProvider(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest)
  const providers = application.provider ?? []
  if (!providers.some((provider) => provider.$?.['android:name'] === PROVIDER_NAME)) {
    providers.push({
      $: {
        'android:name': PROVIDER_NAME,
        'android:authorities': '${applicationId}.native-crash-init',
        'android:exported': 'false',
        'android:initOrder': '2147483647',
      },
    })
  }
  application.provider = providers
  return manifest
}

function nativeCrashReporterSource(packageName) {
  return `package ${packageName}

import android.content.Context
import android.os.Build
import android.os.Process
import org.json.JSONObject
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

object NativeCrashReporter {
  private const val FILE_NAME = "native-crash.json"
  private const val MAX_STACK_CHARS = 16000

  fun install(context: Context) {
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
      try {
        persist(context, thread, throwable)
      } catch (_: Throwable) {
        // Diagnostics must never replace the original crash.
      } finally {
        if (previous != null) {
          previous.uncaughtException(thread, throwable)
        } else {
          Process.killProcess(Process.myPid())
        }
      }
    }
  }

  private fun persist(context: Context, thread: Thread, throwable: Throwable) {
    val stackWriter = StringWriter()
    throwable.printStackTrace(PrintWriter(stackWriter))
    val stack = stackWriter.toString().take(MAX_STACK_CHARS)
    val payload = JSONObject()
      .put("created_at", System.currentTimeMillis())
      .put("message", throwable.javaClass.name + ": " + (throwable.message ?: ""))
      .put("stack", stack)
      .put("thread", thread.name)
      .put("os_version", Build.VERSION.RELEASE ?: "unknown")

    val target = File(context.filesDir, FILE_NAME)
    val temporary = File(context.filesDir, FILE_NAME + ".tmp")
    temporary.writeText(payload.toString(), Charsets.UTF_8)
    if (!temporary.renameTo(target)) {
      target.writeText(payload.toString(), Charsets.UTF_8)
      temporary.delete()
    }
  }
}

class NativeCrashInitProvider : android.content.ContentProvider() {
  override fun onCreate(): Boolean {
    context?.let { NativeCrashReporter.install(it) }
    return true
  }

  override fun query(uri: android.net.Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?) = null
  override fun getType(uri: android.net.Uri): String? = null
  override fun insert(uri: android.net.Uri, values: android.content.ContentValues?) = null
  override fun delete(uri: android.net.Uri, selection: String?, selectionArgs: Array<out String>?) = 0
  override fun update(uri: android.net.Uri, values: android.content.ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
}
`
}

const withNativeCrashReporting = (config) => {
  config = withAndroidManifest(config, (mod) => {
    mod.modResults = addCrashInitProvider(mod.modResults)
    return mod
  })
  return withDangerousMod(config, [
    'android',
    async (mod) => {
      const packageName = mod.android?.package
      if (typeof packageName !== 'string' || packageName.length === 0) {
        throw new Error('Native crash reporting requires expo.android.package')
      }
      const sourceDir = path.join(
        mod.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'java',
        ...packageName.split('.'),
      )
      fs.mkdirSync(sourceDir, { recursive: true })
      fs.writeFileSync(
        path.join(sourceDir, 'NativeCrashReporter.kt'),
        nativeCrashReporterSource(packageName),
      )
      return mod
    },
  ])
}

module.exports = withNativeCrashReporting
module.exports.addCrashInitProvider = addCrashInitProvider
module.exports.nativeCrashReporterSource = nativeCrashReporterSource
