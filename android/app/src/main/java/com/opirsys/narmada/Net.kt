package com.opirsys.narmada

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.net.HttpURLConnection
import java.net.URL

/**
 * Small HTTP helper the background service uses when the app screen is not open.
 * The web UI hands over the server address, the login token and the live-sharing
 * choice (Bridge.setAuth); they are kept in the app's private storage.
 */
object Net {
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("net", Context.MODE_PRIVATE)
    fun live(ctx: Context) = prefs(ctx).getBoolean("live", false) && token(ctx).isNotEmpty()
    fun setLive(ctx: Context, on: Boolean) = prefs(ctx).edit().putBoolean("live", on).apply()
    private fun token(ctx: Context) = prefs(ctx).getString("token", "") ?: ""
    private fun server(ctx: Context) = (prefs(ctx).getString("server", "") ?: "").trimEnd('/')

    fun family(ctx: Context) = prefs(ctx).getBoolean("family", false) && token(ctx).isNotEmpty()

    fun save(ctx: Context, server: String, token: String, live: Boolean, family: Boolean) {
        prefs(ctx).edit().putString("server", server).putString("token", token).putBoolean("live", live).putBoolean("family", family).apply()
        val wm = WorkManager.getInstance(ctx)
        if (token.isEmpty()) wm.cancelUniqueWork("notify")
        else wm.enqueueUniquePeriodicWork("notify", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<NotifyWorker>(15, TimeUnit.MINUTES).build())
    }

    fun get(ctx: Context, path: String): String? {
        val t = token(ctx); val s = server(ctx)
        if (t.isEmpty() || s.isEmpty()) return null
        return try {
            val c = URL("$s/api/v1$path").openConnection() as HttpURLConnection
            c.connectTimeout = 15_000; c.readTimeout = 30_000
            c.setRequestProperty("Authorization", "Bearer $t")
            val body = if (c.responseCode in 200..299) c.inputStream.bufferedReader().use { it.readText() } else null
            c.disconnect(); body
        } catch (e: Exception) { null }
    }

    private const val CH_FAMILY = "family"

    /** Ask the server what is new (photo requests, family photos, invitations) and show phone notifications.
     *  While the app is on screen it shows these itself, so then we only move the "since" mark forward. */
    fun checkNotify(ctx: Context) {
        val p = prefs(ctx)
        val since = p.getFloat("notifySince", (System.currentTimeMillis() / 1000.0 - 600).toFloat()).toDouble()
        val body = get(ctx, "/notify?since=$since") ?: return
        val j = try { JSONObject(body) } catch (e: Exception) { return }
        p.edit().putFloat("notifySince", j.optDouble("now", since).toFloat()).apply()
        if (MainActivity.inForeground) return
        val items = j.optJSONArray("items") ?: return
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CH_FAMILY) == null) {
            nm.createNotificationChannel(NotificationChannel(CH_FAMILY, "Family", NotificationManager.IMPORTANCE_HIGH)
                .apply { description = "Photo requests and new photos from your family" })
        }
        for (i in 0 until items.length()) {
            val it = items.getJSONObject(i)
            val kind = it.optString("kind"); val id = it.optInt("id")
            val open = if (kind == "ask") "ask:$id" else "family"
            val intent = Intent(ctx, MainActivity::class.java).putExtra("open", open)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            val pi = PendingIntent.getActivity(ctx, (kind.hashCode() * 31 + id), intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val n = NotificationCompat.Builder(ctx, CH_FAMILY)
                .setSmallIcon(R.drawable.ic_stat_walk)
                .setContentTitle(it.optString("title"))
                .setContentText(it.optString("text"))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true).setContentIntent(pi).build()
            try { nm.notify(kind.hashCode() * 31 + id, n) } catch (e: SecurityException) { /* notifications not allowed */ }
        }
    }

    /** POST to /api/v1<path>; returns the HTTP status, or -1 without internet. */
    fun post(ctx: Context, path: String, body: String, type: String): Int {
        val t = token(ctx); val s = server(ctx)
        if (t.isEmpty() || s.isEmpty()) return -1
        return try {
            val c = URL("$s/api/v1$path").openConnection() as HttpURLConnection
            c.requestMethod = "POST"; c.doOutput = true
            c.connectTimeout = 15_000; c.readTimeout = 30_000
            c.setRequestProperty("Authorization", "Bearer $t")
            c.setRequestProperty("Content-Type", type)
            c.outputStream.use { it.write(body.toByteArray()) }
            val code = c.responseCode
            runCatching { (if (code < 400) c.inputStream else c.errorStream)?.close() }
            c.disconnect()
            if (code == 401) prefs(ctx).edit().putString("token", "").apply()   // logged out elsewhere
            code
        } catch (e: Exception) { -1 }
    }

    /** Send journey points recorded on the phone, oldest first, then forget the sent ones. */
    fun uploadPoints(ctx: Context) {
        repeat(10) {
            val pts = PointStore.read(ctx, 2000)
            if (pts == "[]") return
            val arr = org.json.JSONArray(pts)
            var maxTs = 0.0
            for (i in 0 until arr.length()) maxTs = maxOf(maxTs, arr.getJSONObject(i).getDouble("ts"))
            val code = post(ctx, "/timeline/points", "{\"points\":$pts}", "application/json")
            if (code !in 200..299) return
            PointStore.clearUpTo(ctx, maxTs)
        }
    }
}
