package io.updatecanary.integration;
import static org.junit.jupiter.api.Assertions.*;import io.updatecanary.model.Verdict;import java.util.*;import java.util.stream.*;import org.junit.jupiter.api.*;import org.junit.jupiter.params.ParameterizedTest;import org.junit.jupiter.params.provider.*;
class CanonicalFixtureSuiteTest {
 static Stream<Arguments> canonicalCases(){return Stream.of(
  Arguments.of("normal patch update",FixtureWorkspace.Scenario.NORMAL_PATCH,Verdict.UPDATE_SAFE),
  Arguments.of("config addition",FixtureWorkspace.Scenario.CONFIG_ADDITION,Verdict.UPDATE_SAFE),
  Arguments.of("command added",FixtureWorkspace.Scenario.COMMAND_ADDED,Verdict.REVIEW),
  Arguments.of("permission added",FixtureWorkspace.Scenario.PERMISSION_ADDED,Verdict.REVIEW),
  Arguments.of("config key removed",FixtureWorkspace.Scenario.CONFIG_KEY_REMOVED,Verdict.REVIEW),
  Arguments.of("soft dependency change",FixtureWorkspace.Scenario.SOFT_DEPENDENCY_CHANGE,Verdict.REVIEW),
  Arguments.of("plugin load failure",FixtureWorkspace.Scenario.PLUGIN_LOAD_FAILURE,Verdict.BLOCK),
  Arguments.of("missing hard dependency",FixtureWorkspace.Scenario.MISSING_HARD_DEPENDENCY,Verdict.BLOCK),
  Arguments.of("server/runtime incompatibility",FixtureWorkspace.Scenario.SERVER_RUNTIME_INCOMPATIBILITY,Verdict.BLOCK),
  Arguments.of("config type migration failure",FixtureWorkspace.Scenario.CONFIG_TYPE_MIGRATION_FAILURE,Verdict.BLOCK),
  Arguments.of("data migration corruption",FixtureWorkspace.Scenario.DATA_MIGRATION_CORRUPTION,Verdict.BLOCK),
  Arguments.of("new severe warning while plugin remains enabled",FixtureWorkspace.Scenario.NEW_SEVERE_WARNING,Verdict.REVIEW));}
 @ParameterizedTest(name="{0} -> {2}") @MethodSource("canonicalCases") @Tag("docker") void canonicalExpectedVerdict(String name,FixtureWorkspace.Scenario scenario,Verdict expected)throws Exception{assertEquals(expected,new DockerFixtureWorkspace().evaluate(scenario));}
 @Test void allTwelveCanonicalVerdictsAreDeterministicAcrossTwoRuns(){List<Arguments>cases=canonicalCases().toList();assertEquals(12,cases.size());for(int run=0;run<2;run++)for(Arguments a:cases){Object[]v=a.get();assertEquals(v[2],new FixtureWorkspace().evaluate((FixtureWorkspace.Scenario)v[1]));}}
 @Test @Tag("docker") void releaseDockerGateRequiresDocker(){assertTrue(new io.updatecanary.runner.DockerCanaryRunner().dockerAvailable(),"Docker must be installed/running for release acceptance: mvn verify -Dgroups=docker");}
}
