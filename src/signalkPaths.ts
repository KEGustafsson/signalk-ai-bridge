export const SIGNALK_PATHS = {
  selfVessel: '/signalk/v1/api/vessels/self',
  selfNavigation: '/signalk/v1/api/vessels/self/navigation',
  selfNavigationPosition: '/signalk/v1/api/vessels/self/navigation/position',
  selfNavigationSog: '/signalk/v1/api/vessels/self/navigation/speedOverGround',
  selfNavigationCogt: '/signalk/v1/api/vessels/self/navigation/courseOverGroundTrue',
  selfAlarms: '/signalk/v1/api/vessels/self/notifications'
} as const;

export const APP_DATA_KEYS = {
  lastFlattenedSnapshot: 'ai-bridge/last-flattened-snapshot',
  lastWaypointDraft: 'ai-bridge/last-waypoint-draft',
  pathAccessRules: 'ai-bridge/path-access-rules'
} as const;
