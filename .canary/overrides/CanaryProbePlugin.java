package io.updatecanary.probe;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import org.bukkit.Server;
import org.bukkit.command.Command;
import org.bukkit.command.PluginIdentifiableCommand;
import org.bukkit.permissions.Permission;
import org.bukkit.plugin.java.JavaPlugin;

public final class CanaryProbePlugin extends JavaPlugin {
    @Override
    public void onEnable() {
        try {
            Path out = Path.of(System.getProperty("canary.probe.output", "canary-probe.json"));
            Server server = getServer();
            List<ProbeSnapshotWriter.PluginState> plugins = Arrays.stream(server.getPluginManager().getPlugins())
                    .map(plugin -> new ProbeSnapshotWriter.PluginState(
                            plugin.getName(), plugin.getDescription().getVersion(), plugin.isEnabled()))
                    .toList();
            List<ProbeSnapshotWriter.PermissionState> permissions = server.getPluginManager().getPermissions().stream()
                    .sorted(Comparator.comparing(Permission::getName))
                    .map(permission -> new ProbeSnapshotWriter.PermissionState(
                            permission.getName(), String.valueOf(permission.getDefault())))
                    .toList();

            List<ProbeSnapshotWriter.CommandState> commands = new ArrayList<>();
            boolean commandsComplete = true;
            try {
                Field commandMapField = server.getClass().getDeclaredField("commandMap");
                commandMapField.setAccessible(true);
                Object commandMap = commandMapField.get(server);
                Method getKnownCommands = commandMap.getClass().getMethod("getKnownCommands");
                Object raw = getKnownCommands.invoke(commandMap);
                if (raw instanceof Map<?, ?> map) {
                    for (var entry : map.entrySet()) {
                        if (entry.getValue() instanceof Command command) {
                            String owner = command instanceof PluginIdentifiableCommand identifiable
                                    ? identifiable.getPlugin().getName()
                                    : "";
                            commands.add(new ProbeSnapshotWriter.CommandState(
                                    String.valueOf(entry.getKey()), owner, command.getPermission()));
                        }
                    }
                }
            } catch (Exception ignored) {
                commandsComplete = false;
            }

            new ProbeSnapshotWriter().write(
                    out,
                    new ProbeSnapshotWriter.ServerInfo(
                            server.getName(),
                            minecraftVersionFromBukkitVersion(server.getBukkitVersion()),
                            System.getProperty("java.version")),
                    plugins,
                    commands,
                    permissions,
                    commandsComplete);
        } catch (Exception error) {
            getLogger().severe("Canary probe failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    static String minecraftVersionFromBukkitVersion(String bukkitVersion) {
        if (bukkitVersion == null || bukkitVersion.isBlank()) {
            return "unknown";
        }
        int separator = bukkitVersion.indexOf('-');
        return separator > 0 ? bukkitVersion.substring(0, separator) : bukkitVersion;
    }
}
