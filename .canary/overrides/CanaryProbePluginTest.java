package io.updatecanary.probe;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CanaryProbePluginTest {
    @Test
    void derivesMinecraftVersionFromBukkitVersion() {
        assertEquals("1.21.11", CanaryProbePlugin.minecraftVersionFromBukkitVersion("1.21.11-R0.1-SNAPSHOT"));
        assertEquals("1.21.11", CanaryProbePlugin.minecraftVersionFromBukkitVersion("1.21.11"));
        assertEquals("unknown", CanaryProbePlugin.minecraftVersionFromBukkitVersion(""));
    }
}
