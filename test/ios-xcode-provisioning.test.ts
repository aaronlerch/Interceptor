import { describe, expect, test } from "bun:test"
import { chooseXcodeTeam, parseXcodeTeams } from "../daemon/ios/tools"

describe("ios Xcode provisioning helpers", () => {
  test("parseXcodeTeams extracts teams from Xcode defaults output", () => {
    const teams = parseXcodeTeams(`{
    "A" =     (
                {
            isFreeProvisioningTeam = 1;
            teamID = AW72CLPK5T;
            teamName = "Jane Appleseed (Personal Team)";
            teamType = "Personal Team";
        }
    );
    "B" =     (
                {
            isFreeProvisioningTeam = 0;
            teamID = TPWBZD35WW;
            teamName = "HACKER VALLEY MEDIA, LLC";
            teamType = Company;
        }
    );
}`)
    expect(teams).toEqual([
      {
        teamId: "AW72CLPK5T",
        teamName: "Jane Appleseed (Personal Team)",
        teamType: "Personal Team",
        isFreeProvisioningTeam: true,
      },
      {
        teamId: "TPWBZD35WW",
        teamName: "HACKER VALLEY MEDIA, LLC",
        teamType: "Company",
        isFreeProvisioningTeam: false,
      },
    ])
  })

  test("chooseXcodeTeam honors an explicit override", () => {
    expect(chooseXcodeTeam([], "ABCDE12345")).toEqual({ teamId: "ABCDE12345" })
  })

  test("chooseXcodeTeam picks the single configured team", () => {
    expect(chooseXcodeTeam([{ teamId: "AW72CLPK5T", isFreeProvisioningTeam: true }])).toEqual({ teamId: "AW72CLPK5T" })
  })

  test("chooseXcodeTeam picks the single paid team when personal teams also exist", () => {
    const selected = chooseXcodeTeam([
      { teamId: "FREE111111", isFreeProvisioningTeam: true },
      { teamId: "PAID222222", isFreeProvisioningTeam: false },
    ])
    expect(selected).toEqual({ teamId: "PAID222222" })
  })

  test("chooseXcodeTeam requires an explicit team when ambiguous", () => {
    const selected = chooseXcodeTeam([
      { teamId: "FREE111111", isFreeProvisioningTeam: true },
      { teamId: "FREE222222", isFreeProvisioningTeam: true },
    ])
    expect(selected.teamId).toBeUndefined()
    expect(selected.error).toContain("multiple Xcode teams")
  })
})
