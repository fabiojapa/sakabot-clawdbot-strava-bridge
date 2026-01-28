/**
 * Strava API integration
 */

import axios from "axios";

const {
  STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET,
  STRAVA_REFRESH_TOKEN,
} = process.env;

export async function getToken() {
  const r = await axios.post("https://www.strava.com/oauth/token", null, {
    params: {
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: STRAVA_REFRESH_TOKEN,
    },
    timeout: 15000,
  });
  return r.data.access_token;
}

export async function getActivity(activityId, token) {
  const r = await axios.get(`https://www.strava.com/api/v3/activities/${activityId}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
  return r.data;
}

export async function getActivityStreams(activityId, token) {
  const r = await axios.get(`https://www.strava.com/api/v3/activities/${activityId}/streams`, {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      keys: "time,distance,heartrate,watts,cadence,velocity_smooth,temp,altitude",
      key_by_type: true,
    },
    timeout: 15000,
  });
  return r.data;
}

export async function getActivityZones(activityId, token) {
  try {
    const r = await axios.get(`https://www.strava.com/api/v3/activities/${activityId}/zones`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    return r.data;
  } catch {
    return [];
  }
}

export async function listActivities(token, params = {}) {
  const r = await axios.get("https://www.strava.com/api/v3/athlete/activities", {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      per_page: 50,
      ...params,
    },
    timeout: 15000,
  });
  return r.data;
}
