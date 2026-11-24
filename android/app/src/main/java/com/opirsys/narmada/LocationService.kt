package com.opirsys.narmada

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat

/**
 * Foreground service that records the pilgrim's journey for "My timeline",
 * also when the screen is off or there is no internet. Uses the phone's GPS
 * directly (no Google Play services needed).
 */
class LocationService : Service(), LocationListener {

    private var lm: LocationManager? = null
    private var last: Location? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        startInForeground()
        startUpdates()
        running = true
        return START_STICKY
    }

    private fun startInForeground() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Journey recording", NotificationManager.IMPORTANCE_LOW)
                    .apply { description = "Shows while your parikrama journey is being recorded" })
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(
            this, 1, Intent(this, LocationService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_walk)
            .setContentTitle("Narmade Har – recording your journey")
            .setContentText("Your timeline is saved on this phone and uploaded when online.")
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, "Stop", stop)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIF_ID, n)
        }
    }

    @SuppressLint("MissingPermission")
    private fun startUpdates() {
        val m = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        lm = m
        try {
            if (m.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                m.requestLocationUpdates(LocationManager.GPS_PROVIDER, 30_000L, 30f, this, Looper.getMainLooper())
            }
            if (m.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                m.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 60_000L, 50f, this, Looper.getMainLooper())
            }
        } catch (e: SecurityException) {
            stopSelf()
        }
    }

    override fun onLocationChanged(loc: Location) {
        if (loc.accuracy > 250f) return                       // ignore very rough fixes
        val prev = last
        // keep a point when we moved ~80 m, or every 10 minutes while standing still
        if (prev != null && loc.distanceTo(prev) < 80f && loc.time - prev.time < 10 * 60_000L) return
        last = loc
        PointStore.add(this, loc.latitude, loc.longitude, loc.accuracy, loc.time / 1000.0)
    }

    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    override fun onProviderEnabled(provider: String) {}
    override fun onProviderDisabled(provider: String) {}

    override fun onDestroy() {
        lm?.removeUpdates(this)
        running = false
        super.onDestroy()
    }

    companion object {
        const val CHANNEL = "journey"
        const val NOTIF_ID = 42
        const val ACTION_STOP = "com.opirsys.narmada.STOP"
        @Volatile var running = false
    }
}
