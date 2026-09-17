package io.updatecanary.integration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.updatecanary.model.Verdict;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

class CanonicalFixtureSuiteTest {
    private record CanonicalCase(String name, FixtureWorkspace.Scenario scenario, Verdict expected) {}

    private static List<CanonicalCase> cases() {
        return List.of(
                new CanonicalCase("normal patch update", FixtureWorkspace.Scenario.NORMAL_PATCH, Verdict.UPDATE_SAFE),
                new CanonicalCase("config addition", FixtureWorkspace.Scenario.CONFIG_ADDITION, Verdict.UPDATE_SAFE),
                new CanonicalCase("command added", FixtureWorkspace.Scenario.COMMAND_ADDED, Verdict.REVIEW),
                new CanonicalCase("permission added", FixtureWorkspace.Scenario.PERMISSION_ADDED, Verdict.REVIEW),
                new CanonicalCase("config key removed", FixtureWorkspace.Scenario.CONFIG_KEY_REMOVED, Verdict.REVIEW),
                new CanonicalCase("soft dependency change", FixtureWorkspace.Scenario.SOFT_DEPENDENCY_CHANGE, Verdict.REVIEW),
                new CanonicalCase("plugin load failure", FixtureWorkspace.Scenario.PLUGIN_LOAD_FAILURE, Verdict.BLOCK),
                new CanonicalCase("missing hard dependency", FixtureWorkspace.Scenario.MISSING_HARD_DEPENDENCY, Verdict.BLOCK),
                new CanonicalCase("server/runtime incompatibility", FixtureWorkspace.Scenario.SERVER_RUNTIME_INCOMPATIBILITY, Verdict.BLOCK),
                new CanonicalCase("config type migration failure", FixtureWorkspace.Scenario.CONFIG_TYPE_MIGRATION_FAILURE, Verdict.BLOCK),
                new CanonicalCase("data migration corruption", FixtureWorkspace.Scenario.DATA_MIGRATION_CORRUPTION, Verdict.BLOCK),
                new CanonicalCase("new severe warning while plugin remains enabled", FixtureWorkspace.Scenario.NEW_SEVERE_WARNING, Verdict.REVIEW));
    }

    static Stream<Arguments> canonicalCases() {
        return cases().stream().map(testCase -> Arguments.of(testCase.name(), testCase.scenario(), testCase.expected()));
    }

    @ParameterizedTest(name = "{0} -> {2}")
    @MethodSource("canonicalCases")
    @Tag("docker")
    void canonicalExpectedVerdict(String name, FixtureWorkspace.Scenario scenario, Verdict expected) throws Exception {
        assertEquals(expected, new DockerFixtureWorkspace().evaluate(scenario));
    }

    @Test
    void allTwelveCanonicalVerdictsAreDeterministicAcrossTwoRuns() {
        List<CanonicalCase> cases = cases();
        assertEquals(12, cases.size());
        for (int run = 0; run < 2; run++) {
            for (CanonicalCase testCase : cases) {
                assertEquals(testCase.expected(), new FixtureWorkspace().evaluate(testCase.scenario()));
            }
        }
    }

    @Test
    @Tag("docker")
    void releaseDockerGateRequiresDocker() {
        assertTrue(
                new io.updatecanary.runner.DockerCanaryRunner().dockerAvailable(),
                "Docker must be installed/running for release acceptance: mvn verify -Dgroups=docker");
    }
}
